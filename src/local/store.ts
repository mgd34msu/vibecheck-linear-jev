// SqliteLocalStore: the LocalStore (src/local/types.ts) on one bun:sqlite file.
//
// Keys and filter columns are real columns; the rest of each row travels as a
// JSON body that is validated with zod when read back. The file runs in WAL
// mode with a busy timeout, so several processes (hooks, the MCP server) can
// share it. The schema version lives in the `meta` table; migrations only move
// forward, each inside one immediate write transaction.
//
// Verification entries (src/verification/store.ts) live in the same file in
// the `verifications` table. `verificationAccess()` gives that module the
// SqlAccess it expects.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Issue } from "../linear/api.js";
import { stateDatabasePath } from "../paths.js";
import type { SqlAccess, SqlValue } from "../sqlite.js";
import type {
  CompletionRow,
  CompletionStep,
  EventKind,
  EventRow,
  JournalRevision,
  LocalStore,
  OutboxKind,
  OutboxRow,
  ProjectKey,
  ProjectRow,
  SessionId,
  SessionRow,
  WorkId,
  WorkRow,
  WorkStatus,
} from "./types.js";

/** Newest schema version this build writes. */
export const STATE_SCHEMA_VERSION = 4;

/** Work in these statuses no longer holds its issue. */
const FINISHED_STATUSES: readonly WorkStatus[] = [
  "complete",
  "released",
  "abandoned",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Each entry upgrades the file from the previous version; append only. */
const migrations: readonly (readonly string[])[] = [
  [
    `CREATE TABLE projects (
      key TEXT PRIMARY KEY, linear_project_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL
    )`,
    "CREATE INDEX projects_linear ON projects(linear_project_id)",
    `CREATE TABLE project_repositories (
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      PRIMARY KEY (identity, project_key)
    )`,
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, vendor TEXT NOT NULL,
      runtime TEXT NOT NULL, external_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, body TEXT NOT NULL
    )`,
    "CREATE INDEX sessions_project ON sessions(project_key, created_at)",
    "CREATE INDEX sessions_external ON sessions(external_session_id, vendor, runtime)",
    `CREATE TABLE claims (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, issue_id TEXT NOT NULL,
      session_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL
    )`,
    "CREATE INDEX claims_issue ON claims(project_key, issue_id, created_at)",
    "CREATE INDEX claims_session ON claims(session_id, created_at)",
    "CREATE INDEX claims_status ON claims(project_key, status)",
    `CREATE TABLE receipts (
      scope TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      result TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (scope, request_id)
    )`,
    "CREATE INDEX receipts_created ON receipts(created_at)",
    `CREATE TABLE journal (
      project_key TEXT NOT NULL, revision INTEGER NOT NULL,
      created_at TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (project_key, revision)
    )`,
    `CREATE TABLE issue_cache (
      project_key TEXT NOT NULL, issue_id TEXT NOT NULL,
      updated_at TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (project_key, issue_id)
    )`,
    `CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT, kind TEXT NOT NULL,
      payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT
    )`,
    "CREATE INDEX outbox_pending ON outbox(id) WHERE sent_at IS NULL",
    // The verification history, exactly as src/verification/store.ts expects.
    `CREATE TABLE verifications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      project_id TEXT, task_id TEXT, work_id TEXT, session_id TEXT,
      kind TEXT NOT NULL, battery_id TEXT, source TEXT NOT NULL,
      created_at TEXT NOT NULL, body TEXT NOT NULL
    )`,
    "CREATE INDEX verifications_task ON verifications(project_id, task_id, seq)",
    "CREATE INDEX verifications_work ON verifications(project_id, work_id, seq)",
    "CREATE INDEX verifications_battery ON verifications(kind, battery_id, seq)",
    "CREATE INDEX verifications_session ON verifications(session_id, seq)",
    ...["UPDATE", "DELETE"].map(
      (event) =>
        `CREATE TRIGGER verifications_immutable_${event.toLowerCase()}
         BEFORE ${event} ON verifications
         BEGIN SELECT RAISE(ABORT, 'history is immutable'); END`,
    ),
  ],
  [
    `CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL,
      kind TEXT NOT NULL, issue_id TEXT NOT NULL, dedupe TEXT NOT NULL,
      created_at TEXT NOT NULL, cleared_at TEXT, body TEXT NOT NULL,
      UNIQUE (project_key, dedupe)
    )`,
    "CREATE INDEX events_open ON events(project_key, kind) WHERE cleared_at IS NULL",
  ],
  [
    `CREATE TABLE completions (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, work_id TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      body TEXT NOT NULL
    )`,
    "CREATE INDEX completions_work ON completions(work_id, created_at)",
    "CREATE INDEX completions_pending ON completions(project_key, created_at) WHERE state = 'pending'",
  ],
  [
    // Label names by id, as the MCP server last read them from Linear:
    // hooks never call Linear and read the tool's labels on cached issues
    // through this table.
    `CREATE TABLE label_names (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    // The Stop hook's block count (src/jev/hooks/stop.ts blocksSoFar): its
    // own verdicts of one session and user message.
    `CREATE INDEX verifications_stop_blocks ON verifications(
       json_extract(body, '$.external_session_id'),
       json_extract(body, '$.evidence.line'),
       json_extract(body, '$.outcome')
     ) WHERE source = 'hook:stop' AND kind = 'verdict'`,
  ],
];

function brand<T extends string>(): z.ZodType<T> {
  return z.custom<T>((value) => typeof value === "string");
}

const projectKey = brand<ProjectKey>();
const sessionId = brand<SessionId>();
const workId = brand<WorkId>();
const jsonObject = z.record(z.string(), z.unknown());

const eventKinds: readonly [EventKind, ...EventKind[]] = [
  "reopened",
  "held_done_moved",
  "removed",
  "human_reply",
  "recheck",
  "skipped_move",
  "claim_lost",
  "write_dropped",
  "expected_move",
  "verdict_floor",
];
const eventBodySchema = z.strictObject({
  identifier: z.string(),
  workId: workId.nullable(),
  body: jsonObject,
});
const eventRowSchema = z.object({
  id: z.number().int(),
  project_key: projectKey,
  kind: z.enum(eventKinds),
  issue_id: z.string(),
  dedupe: z.string(),
  created_at: z.string(),
  cleared_at: z.string().nullable(),
  body: z.string(),
});

const labelNameRowSchema = z.object({ id: z.string(), name: z.string() });

const projectSchema = z.strictObject({
  key: projectKey,
  linearProjectId: z.string(),
  teamId: z.string(),
  repositories: z.array(z.string()),
  policyDocumentId: z.string().nullable(),
  planDocumentId: z.string().nullable(),
  planRevision: z.number().int(),
  coordinatorSessionId: sessionId.nullable(),
  syncedThrough: z.string().nullable(),
  adoption: z.enum(["created", "as_is", "managed", "pending"]),
  managedConfirmed: z.boolean(),
  dryRunHash: z.string().nullable().optional(),
  readyAt: z.string().nullable().optional(),
  policy: jsonObject.nullable(),
  url: z.string().nullable(),
  name: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ProjectRow>;

const sessionSchema = z.strictObject({
  id: sessionId,
  projectKey,
  vendor: z.string(),
  runtime: z.string(),
  externalSessionId: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  parentSessionId: sessionId.nullable(),
  agentLabel: z.string(),
  acknowledgedPlanRevision: z.number().int().nullable(),
  acknowledgedAt: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
}) satisfies z.ZodType<SessionRow>;

const workSchema = z.strictObject({
  id: workId,
  projectKey,
  issueId: z.string(),
  identifier: z.string(),
  sessionId,
  status: z.enum([
    "in_progress",
    "blocked",
    "awaiting_integration",
    "complete",
    "released",
    "abandoned",
    "conflict",
  ]),
  blocker: z.string().nullable(),
  location: z.strictObject({
    repository: z.string().nullable(),
    checkout: z.string().nullable(),
    branch: z.string().nullable(),
    targetBranch: z.string().nullable(),
    baseCommit: z.string().nullable(),
    paths: z.array(z.string()),
  }),
  commit: z.string().nullable(),
  integrationCommit: z.string().nullable(),
  integrationRequired: z.boolean(),
  claimCommentId: z.string().nullable(),
  predecessorWorkId: workId.nullable(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<WorkRow>;

const completionStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("move"),
    stateId: z.string(),
    expectStateId: z.string().nullable(),
    alsoExpect: z.array(z.string()).optional(),
    required: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("add_label"), name: z.string() }),
  z.strictObject({ kind: z.literal("remove_label"), name: z.string() }),
  z.strictObject({ kind: z.literal("agent_label"), name: z.string() }),
  z.strictObject({
    kind: z.literal("comment"),
    id: z.string(),
    body: z.string(),
  }),
  z.strictObject({ kind: z.literal("activity"), at: z.string() }),
  z.strictObject({ kind: z.literal("close_claim") }),
  z.strictObject({ kind: z.literal("drop_claimed") }),
]) satisfies z.ZodType<CompletionStep>;

const completionSchema = z.strictObject({
  id: z.string(),
  projectKey,
  workId,
  sessionId,
  requestId: z.string(),
  issueId: z.string(),
  identifier: z.string(),
  taskKey: z.string(),
  kind: z.enum(["complete", "release", "handoff"]),
  decision: z.enum(["verified", "unverified", "held"]).nullable(),
  closingStatus: z.string().nullable(),
  steps: z.array(completionStepSchema),
  done: z.number().int(),
  state: z.enum(["pending", "done", "abandoned"]),
  reason: z.string().nullable(),
  attempts: z.number().int(),
  changeHash: z.string(),
  change: jsonObject,
  rows: z.array(workSchema),
  taskStatus: z.string(),
  verification: z.array(jsonObject),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<CompletionRow>;

const revisionSchema = z.strictObject({
  projectKey,
  revision: z.number().int(),
  sessionId: sessionId.nullable(),
  createdAt: z.string(),
  tasks: z.array(
    z.strictObject({
      key: z.string(),
      issueId: z.string(),
      identifier: z.string(),
      title: z.string(),
      definition: jsonObject,
    }),
  ),
  policy: jsonObject.nullable(),
  plan: jsonObject.nullable(),
}) satisfies z.ZodType<JournalRevision>;

const issueSchema = z.strictObject({
  id: z.string(),
  identifier: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  stateId: z.string(),
  stateType: z.enum([
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
  ]),
  stateName: z.string(),
  priority: z.number(),
  estimate: z.number().nullable(),
  labelIds: z.array(z.string()),
  projectId: z.string().nullable(),
  projectMilestoneId: z.string().nullable(),
  parentId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  dueDate: z.string().nullable(),
  branchName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
}) satisfies z.ZodType<Issue>;

const outboxKinds: readonly [OutboxKind, ...OutboxKind[]] = [
  "comment",
  "update_comment",
  "add_label",
  "remove_label",
  "update_issue",
  "project_update",
  "relation",
];

const outboxSchema = z.object({
  id: z.number().int(),
  project_key: projectKey.nullable(),
  kind: z.enum(outboxKinds),
  payload: z.string(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  created_at: z.string(),
});

const bodySchema = z.object({ body: z.string() });
const countSchema = z.object({ count: z.number().int() });
const receiptSchema = z.object({ input_hash: z.string(), result: z.string() });
const versionSchema = z.object({ value: z.string() });
const idSchema = z.object({ id: z.number().int() });

function parseBody<T>(schema: z.ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text));
}

/** Same shape db.ts gives its entries: ISO time with microseconds and an explicit offset. */
function entryTimestamp(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

export interface SqliteLocalStoreOptions {
  /** The clock for created-at stamps and receipt pruning; tests substitute their own. */
  readonly now?: () => Date;
  /** How long a writer waits for another process's lock. Default 30 seconds. */
  readonly busyTimeoutMs?: number;
}

/** The local store on one SQLite file. Open it once per process and close it when done. */
export class SqliteLocalStore implements LocalStore {
  private readonly database: Database;
  private readonly now: () => Date;
  private depth = 0;

  constructor(
    path: string = stateDatabasePath(),
    options: SqliteLocalStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { create: true, strict: true });
    try {
      this.database.exec(
        `PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 30_000)}`,
      );
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = NORMAL");
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  /** The schema version recorded in the file. */
  schemaVersion(): number {
    return this.readVersion();
  }

  close(): void {
    this.database.close();
  }

  private rows<T>(schema: z.ZodType<T>, sql: string, values: SqlValue[]): T[] {
    const statement = this.database.prepare<unknown, SqlValue[]>(sql);
    try {
      return statement.all(...values).map((row) => schema.parse(row));
    } finally {
      statement.finalize();
    }
  }

  private run(sql: string, values: SqlValue[] = []): number {
    const statement = this.database.prepare<unknown, SqlValue[]>(sql);
    try {
      return statement.run(...values).changes;
    } finally {
      statement.finalize();
    }
  }

  private bodies<T>(
    schema: z.ZodType<T>,
    sql: string,
    values: SqlValue[],
  ): T[] {
    return this.rows(bodySchema, sql, values).map((row) =>
      parseBody(schema, row.body),
    );
  }

  private readVersion(): number {
    const table = this.rows(
      z.object({ name: z.string() }),
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
      [],
    );
    if (table.length === 0) return 0;
    const row = this.rows(
      versionSchema,
      "SELECT value FROM meta WHERE key = 'schema_version'",
      [],
    )[0];
    return row === undefined ? 0 : Number.parseInt(row.value, 10);
  }

  private migrate(): void {
    this.transaction(() => {
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      const current = this.readVersion();
      if (current > STATE_SCHEMA_VERSION)
        throw new Error(
          `state database has schema version ${current}; this build supports up to ${STATE_SCHEMA_VERSION}`,
        );
      for (let version = current; version < migrations.length; version++) {
        for (const statement of migrations[version] ?? [])
          this.database.exec(statement);
        this.run(
          "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [String(version + 1)],
        );
      }
    });
  }

  /**
   * Runs `fn` in one immediate write transaction. A nested call joins the
   * outer transaction through a savepoint, so an error it throws undoes only
   * its own writes if the outer function catches it.
   */
  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0;
    const savepoint = `nested_${this.depth}`;
    this.database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const result = fn();
      if (result instanceof Promise)
        throw new Error("local store transactions must be synchronous");
      this.database.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      if (nested) {
        this.database.exec(`ROLLBACK TO ${savepoint}`);
        this.database.exec(`RELEASE ${savepoint}`);
      } else {
        this.database.exec("ROLLBACK");
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  /**
   * The row access src/verification/store.ts takes (`appendEntry`,
   * `queryEntries`). Statements run on this store's connection, so inside
   * `transaction` they join it.
   */
  verificationAccess(): SqlAccess {
    const store = this;
    return {
      get now() {
        return entryTimestamp();
      },
      queryRows: (schema, sql, values) => store.rows(schema, sql, values),
      execute: (sql, values) => {
        store.run(sql, values);
      },
    };
  }

  project(key: ProjectKey): ProjectRow | undefined {
    return this.bodies(
      projectSchema,
      "SELECT body FROM projects WHERE key = ?",
      [key],
    )[0];
  }

  projectByLinearId(linearProjectId: string): ProjectRow | undefined {
    return this.bodies(
      projectSchema,
      "SELECT body FROM projects WHERE linear_project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [linearProjectId],
    )[0];
  }

  allProjects(): readonly ProjectRow[] {
    return this.bodies(
      projectSchema,
      "SELECT body FROM projects ORDER BY created_at DESC, rowid DESC",
      [],
    );
  }

  projectsForRepository(identities: readonly string[]): readonly ProjectRow[] {
    if (identities.length === 0) return [];
    return this.bodies(
      projectSchema,
      `SELECT body FROM projects WHERE key IN (
         SELECT project_key FROM project_repositories
         WHERE identity IN (SELECT value FROM json_each(?)))
       ORDER BY created_at DESC, rowid DESC`,
      [JSON.stringify(identities)],
    );
  }

  putProject(row: ProjectRow): void {
    const body = projectSchema.parse(row);
    this.transaction(() => {
      this.run(
        `INSERT INTO projects(key, linear_project_id, created_at, updated_at, body)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET linear_project_id = excluded.linear_project_id,
           created_at = excluded.created_at, updated_at = excluded.updated_at, body = excluded.body`,
        [
          body.key,
          body.linearProjectId,
          body.createdAt,
          body.updatedAt,
          JSON.stringify(body),
        ],
      );
      this.run("DELETE FROM project_repositories WHERE project_key = ?", [
        body.key,
      ]);
      for (const identity of new Set(body.repositories))
        this.run(
          "INSERT INTO project_repositories(project_key, identity) VALUES(?, ?)",
          [body.key, identity],
        );
    });
  }

  session(id: SessionId): SessionRow | undefined {
    return this.bodies(
      sessionSchema,
      "SELECT body FROM sessions WHERE id = ?",
      [id],
    )[0];
  }

  sessionByExternal(
    vendor: string,
    runtime: string,
    externalSessionId: string,
  ): SessionRow | undefined {
    return this.bodies(
      sessionSchema,
      `SELECT body FROM sessions WHERE vendor = ? AND runtime = ? AND external_session_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [vendor, runtime, externalSessionId],
    )[0];
  }

  sessionByExternalId(externalSessionId: string): SessionRow | undefined {
    return this.bodies(
      sessionSchema,
      `SELECT body FROM sessions WHERE external_session_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [externalSessionId],
    )[0];
  }

  sessions(key: ProjectKey): readonly SessionRow[] {
    return this.bodies(
      sessionSchema,
      "SELECT body FROM sessions WHERE project_key = ? ORDER BY created_at, rowid",
      [key],
    );
  }

  putSession(row: SessionRow): void {
    const body = sessionSchema.parse(row);
    this.run(
      `INSERT INTO sessions(id, project_key, vendor, runtime, external_session_id, created_at, last_seen_at, body)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_key = excluded.project_key, vendor = excluded.vendor,
         runtime = excluded.runtime, external_session_id = excluded.external_session_id,
         created_at = excluded.created_at, last_seen_at = excluded.last_seen_at, body = excluded.body`,
      [
        body.id,
        body.projectKey,
        body.vendor,
        body.runtime,
        body.externalSessionId,
        body.createdAt,
        body.lastSeenAt,
        JSON.stringify(body),
      ],
    );
  }

  work(id: WorkId): WorkRow | undefined {
    return this.bodies(workSchema, "SELECT body FROM claims WHERE id = ?", [
      id,
    ])[0];
  }

  workForIssue(key: ProjectKey, issueId: string): readonly WorkRow[] {
    return this.bodies(
      workSchema,
      "SELECT body FROM claims WHERE project_key = ? AND issue_id = ? ORDER BY created_at, rowid",
      [key, issueId],
    );
  }

  /** Work that still holds its issue: every status except complete, released and abandoned. */
  openWork(key: ProjectKey): readonly WorkRow[] {
    return this.bodies(
      workSchema,
      `SELECT body FROM claims WHERE project_key = ?
       AND status NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`,
      [key, JSON.stringify(FINISHED_STATUSES)],
    );
  }

  allWork(key: ProjectKey): readonly WorkRow[] {
    return this.bodies(
      workSchema,
      "SELECT body FROM claims WHERE project_key = ? ORDER BY created_at, rowid",
      [key],
    );
  }

  workForSession(id: SessionId): readonly WorkRow[] {
    return this.bodies(
      workSchema,
      "SELECT body FROM claims WHERE session_id = ? ORDER BY created_at, rowid",
      [id],
    );
  }

  putWork(row: WorkRow): void {
    const body = workSchema.parse(row);
    this.run(
      `INSERT INTO claims(id, project_key, issue_id, session_id, status, created_at, updated_at, body)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_key = excluded.project_key, issue_id = excluded.issue_id,
         session_id = excluded.session_id, status = excluded.status,
         created_at = excluded.created_at, updated_at = excluded.updated_at, body = excluded.body`,
      [
        body.id,
        body.projectKey,
        body.issueId,
        body.sessionId,
        body.status,
        body.createdAt,
        body.updatedAt,
        JSON.stringify(body),
      ],
    );
  }

  receipt(
    scope: string,
    requestId: string,
  ): { readonly inputHash: string; readonly result: unknown } | undefined {
    const row = this.rows(
      receiptSchema,
      "SELECT input_hash, result FROM receipts WHERE scope = ? AND request_id = ?",
      [scope, requestId],
    )[0];
    return row === undefined
      ? undefined
      : { inputHash: row.input_hash, result: JSON.parse(row.result) };
  }

  /** Records a result for a request; a repeat of the same scope and request id replaces it. */
  putReceipt(
    scope: string,
    requestId: string,
    inputHash: string,
    result: unknown,
  ): void {
    this.run(
      `INSERT INTO receipts(scope, request_id, input_hash, result, created_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(scope, request_id) DO UPDATE SET input_hash = excluded.input_hash,
         result = excluded.result, created_at = excluded.created_at`,
      [
        scope,
        requestId,
        inputHash,
        JSON.stringify(result === undefined ? null : result),
        this.now().toISOString(),
      ],
    );
  }

  pruneReceipts(days: number): void {
    this.run("DELETE FROM receipts WHERE created_at < ?", [
      new Date(this.now().getTime() - days * DAY_MS).toISOString(),
    ]);
  }

  revision(key: ProjectKey, revision: number): JournalRevision | undefined {
    return this.bodies(
      revisionSchema,
      "SELECT body FROM journal WHERE project_key = ? AND revision = ?",
      [key, revision],
    )[0];
  }

  putRevision(row: JournalRevision): void {
    const body = revisionSchema.parse(row);
    this.run(
      `INSERT INTO journal(project_key, revision, created_at, body) VALUES(?, ?, ?, ?)
       ON CONFLICT(project_key, revision) DO UPDATE SET created_at = excluded.created_at, body = excluded.body`,
      [body.projectKey, body.revision, body.createdAt, JSON.stringify(body)],
    );
  }

  cachedIssues(key: ProjectKey): readonly Issue[] {
    return this.bodies(
      issueSchema,
      "SELECT body FROM issue_cache WHERE project_key = ? ORDER BY updated_at, issue_id",
      [key],
    );
  }

  cacheIssues(key: ProjectKey, issues: readonly Issue[]): void {
    const bodies = issues.map((issue) => issueSchema.parse(issue));
    this.transaction(() => {
      for (const issue of bodies)
        this.run(
          `INSERT INTO issue_cache(project_key, issue_id, updated_at, body) VALUES(?, ?, ?, ?)
           ON CONFLICT(project_key, issue_id) DO UPDATE SET updated_at = excluded.updated_at, body = excluded.body`,
          [key, issue.id, issue.updatedAt, JSON.stringify(issue)],
        );
    });
  }

  uncacheIssue(key: ProjectKey, issueId: string): void {
    this.run("DELETE FROM issue_cache WHERE project_key = ? AND issue_id = ?", [
      key,
      issueId,
    ]);
  }

  enqueue(
    row: Omit<OutboxRow, "id" | "attempts" | "lastError" | "createdAt">,
  ): number {
    return this.transaction(() => {
      this.run(
        "INSERT INTO outbox(project_key, kind, payload, created_at) VALUES(?, ?, ?, ?)",
        [
          row.projectKey,
          z.enum(outboxKinds).parse(row.kind),
          JSON.stringify(row.payload),
          this.now().toISOString(),
        ],
      );
      const inserted = this.rows(
        idSchema,
        "SELECT last_insert_rowid() AS id",
        [],
      )[0];
      if (inserted === undefined)
        throw new Error("outbox insert returned no id");
      return inserted.id;
    });
  }

  /** Unsent rows, oldest first; failed rows stay until sent. */
  pending(limit: number): readonly OutboxRow[] {
    return this.rows(
      outboxSchema,
      `SELECT id, project_key, kind, payload, attempts, last_error, created_at
       FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?`,
      [limit],
    ).map((row) => ({
      id: row.id,
      projectKey: row.project_key,
      kind: row.kind,
      payload: parseBody(jsonObject, row.payload),
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
    }));
  }

  pendingCount(): number {
    return (
      this.rows(
        countSchema,
        "SELECT COUNT(*) AS count FROM outbox WHERE sent_at IS NULL",
        [],
      )[0]?.count ?? 0
    );
  }

  putLabelNames(labels: readonly { id: string; name: string }[]): void {
    if (labels.length === 0) return;
    const now = this.now().toISOString();
    this.transaction(() => {
      for (const label of labels)
        this.run(
          `INSERT INTO label_names(id, name, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name,
             updated_at = excluded.updated_at`,
          [label.id, label.name, now],
        );
    });
  }

  labelNames(): Map<string, string> {
    return new Map(
      this.rows(labelNameRowSchema, "SELECT id, name FROM label_names", []).map(
        (row) => [row.id, row.name],
      ),
    );
  }

  issueQueued(issueId: string): boolean {
    return (
      (this.rows(
        countSchema,
        `SELECT COUNT(*) AS count FROM outbox WHERE sent_at IS NULL AND (
           json_extract(payload, '$.issueId') = ?
           OR (kind = 'update_issue' AND json_extract(payload, '$.id') = ?))`,
        [issueId, issueId],
      )[0]?.count ?? 0) > 0
    );
  }

  completion(id: string): CompletionRow | undefined {
    return this.bodies(
      completionSchema,
      "SELECT body FROM completions WHERE id = ?",
      [id],
    )[0];
  }

  pendingCompletions(key?: ProjectKey): readonly CompletionRow[] {
    return key === undefined
      ? this.bodies(
          completionSchema,
          "SELECT body FROM completions WHERE state = 'pending' ORDER BY created_at, rowid",
          [],
        )
      : this.bodies(
          completionSchema,
          "SELECT body FROM completions WHERE state = 'pending' AND project_key = ? ORDER BY created_at, rowid",
          [key],
        );
  }

  completionsForWork(id: WorkId): readonly CompletionRow[] {
    return this.bodies(
      completionSchema,
      "SELECT body FROM completions WHERE work_id = ? ORDER BY created_at, rowid",
      [id],
    );
  }

  putCompletion(row: CompletionRow): void {
    const body = completionSchema.parse(row);
    this.run(
      `INSERT INTO completions(id, project_key, work_id, state, created_at, updated_at, body)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state,
         updated_at = excluded.updated_at, body = excluded.body`,
      [
        body.id,
        body.projectKey,
        body.workId,
        body.state,
        body.createdAt,
        body.updatedAt,
        JSON.stringify(body),
      ],
    );
  }

  addEvent(row: Omit<EventRow, "id" | "createdAt" | "clearedAt">): boolean {
    const body = eventBodySchema.parse({
      identifier: row.identifier,
      workId: row.workId,
      body: row.body,
    });
    return (
      this.run(
        `INSERT INTO events(project_key, kind, issue_id, dedupe, created_at, body)
         VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(project_key, dedupe) DO NOTHING`,
        [
          row.projectKey,
          z.enum(eventKinds).parse(row.kind),
          row.issueId,
          row.dedupe,
          this.now().toISOString(),
          JSON.stringify(body),
        ],
      ) > 0
    );
  }

  events(
    key: ProjectKey,
    filter: {
      readonly kinds?: readonly EventKind[];
      readonly all?: boolean;
    } = {},
  ): readonly EventRow[] {
    const clauses = ["project_key = ?"];
    const values: SqlValue[] = [key];
    if (filter.all !== true) clauses.push("cleared_at IS NULL");
    if (filter.kinds !== undefined) {
      clauses.push("kind IN (SELECT value FROM json_each(?))");
      values.push(JSON.stringify(filter.kinds));
    }
    return this.rows(
      eventRowSchema,
      `SELECT id, project_key, kind, issue_id, dedupe, created_at, cleared_at, body
       FROM events WHERE ${clauses.join(" AND ")} ORDER BY id`,
      values,
    ).map((row) => {
      const body = parseBody(eventBodySchema, row.body);
      return {
        id: row.id,
        projectKey: row.project_key,
        kind: row.kind,
        issueId: row.issue_id,
        identifier: body.identifier,
        workId: body.workId,
        dedupe: row.dedupe,
        body: body.body,
        createdAt: row.created_at,
        clearedAt: row.cleared_at,
      };
    });
  }

  clearEvent(id: number): void {
    this.run(
      "UPDATE events SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL",
      [this.now().toISOString(), id],
    );
  }

  markSent(id: number): void {
    this.run("UPDATE outbox SET sent_at = ? WHERE id = ?", [
      this.now().toISOString(),
      id,
    ]);
  }

  markFailed(id: number, error: string): void {
    this.run(
      "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?",
      [error, id],
    );
  }
}
