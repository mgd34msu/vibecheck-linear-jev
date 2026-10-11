import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { Issue } from "../src/linear/api.js";
import { STATE_SCHEMA_VERSION, SqliteLocalStore } from "../src/local/store.js";
import type {
  EventRow,
  JournalRevision,
  ProjectKey,
  ProjectRow,
  SessionId,
  SessionRow,
  WorkId,
  WorkRow,
} from "../src/local/types.js";
import { stateDatabasePath } from "../src/paths.js";
import {
  appendEntry,
  labelsByVerdict,
  queryEntries,
  type VerdictBody,
} from "../src/verification/store.js";

function tempFile(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "local-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "nested", "state.sqlite3");
}

function openStore(
  t: TestContext,
  path = tempFile(t),
  now?: () => Date,
): SqliteLocalStore {
  const store = new SqliteLocalStore(path, now === undefined ? {} : { now });
  t.after(() => {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  });
  return store;
}

const brand = <T extends string>(value: string): T =>
  z.custom<T>((input) => typeof input === "string").parse(value);
const key = (value: string) => brand<ProjectKey>(value);
const session = (value: string) => brand<SessionId>(value);
const work = (value: string) => brand<WorkId>(value);

function project(
  name: string,
  overrides: Partial<ProjectRow> = {},
): ProjectRow {
  return {
    key: key(name),
    linearProjectId: `linear-${name}`,
    teamId: "team-1",
    repositories: [`/repos/${name}`],
    policyDocumentId: null,
    planDocumentId: "doc-1",
    planRevision: 1,
    coordinatorSessionId: null,
    syncedThrough: null,
    adoption: "created",
    managedConfirmed: false,
    policy: null,
    url: null,
    name: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sessionRow(
  id: string,
  overrides: Partial<SessionRow> = {},
): SessionRow {
  return {
    id: session(id),
    projectKey: key("alpha"),
    vendor: "anthropic",
    runtime: "claude-code",
    externalSessionId: `ext-${id}`,
    model: "opus",
    effort: null,
    parentSessionId: null,
    agentLabel: "agent:claude-code",
    acknowledgedPlanRevision: null,
    acknowledgedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function workRow(id: string, overrides: Partial<WorkRow> = {}): WorkRow {
  return {
    id: work(id),
    projectKey: key("alpha"),
    issueId: "issue-1",
    identifier: "TA-1",
    sessionId: session("s1"),
    status: "in_progress",
    blocker: null,
    location: {
      repository: "/repos/alpha",
      checkout: "/repos/alpha",
      branch: "feature",
      targetBranch: "main",
      baseCommit: "abc",
      paths: ["src/a.ts"],
    },
    commit: null,
    integrationCommit: null,
    integrationRequired: false,
    claimCommentId: null,
    predecessorWorkId: null,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    identifier: `TA-${id}`,
    url: `https://linear.app/x/issue/TA-${id}`,
    title: `Issue ${id}`,
    description: "",
    stateId: "state-1",
    stateType: "started",
    stateName: "In Progress",
    priority: 2,
    estimate: null,
    labelIds: ["l1"],
    projectId: "linear-alpha",
    projectMilestoneId: null,
    parentId: null,
    assigneeId: null,
    dueDate: null,
    branchName: `ta-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    ...overrides,
  };
}

test("stateDatabasePath is state.sqlite3 in the data folder", () => {
  assert.equal(
    stateDatabasePath({ XDG_DATA_HOME: "/data" }),
    "/data/vibecheck-linear-jev/state.sqlite3",
  );
});

test("a fresh file is migrated to the current version with WAL on", (t) => {
  const path = tempFile(t);
  const store = openStore(t, path);
  assert.equal(store.schemaVersion(), STATE_SCHEMA_VERSION);
  store.close();
  const database = new Database(path, { readonly: true });
  t.after(() => database.close());
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  for (const name of [
    "meta",
    "projects",
    "sessions",
    "claims",
    "receipts",
    "journal",
    "issue_cache",
    "outbox",
    "verifications",
  ])
    assert.ok(tables.includes(name), `missing table ${name}`);
  const mode = database
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
    .get();
  assert.equal(mode?.journal_mode, "wal");
});

test("reopening keeps data and leaves the version alone", (t) => {
  const path = tempFile(t);
  const first = openStore(t, path);
  first.putProject(project("alpha"));
  first.close();
  const second = openStore(t, path);
  assert.equal(second.schemaVersion(), STATE_SCHEMA_VERSION);
  assert.deepEqual(second.project(key("alpha")), project("alpha"));
});

test("a file written by a newer build is refused", (t) => {
  const path = tempFile(t);
  openStore(t, path).close();
  const database = new Database(path);
  database.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
  database.close();
  assert.throws(() => new SqliteLocalStore(path), /schema version 99/);
});

test("projects: lookup, upsert, linear id and repository matching", (t) => {
  const store = openStore(t);
  assert.equal(store.project(key("alpha")), undefined);
  store.putProject(project("alpha", { repositories: ["/r/a", "git@x:a.git"] }));
  store.putProject(
    project("beta", {
      repositories: ["/r/b", "git@x:a.git"],
      createdAt: "2026-02-01T00:00:00.000Z",
    }),
  );
  assert.equal(store.projectByLinearId("linear-beta")?.key, "beta");
  assert.equal(store.projectByLinearId("nope"), undefined);
  assert.deepEqual(
    store.projectsForRepository(["git@x:a.git"]).map((p) => p.key),
    ["beta", "alpha"],
  );
  assert.deepEqual(
    store.projectsForRepository(["/r/a", "/r/b"]).map((p) => p.key),
    ["beta", "alpha"],
  );
  assert.deepEqual(store.projectsForRepository([]), []);
  assert.deepEqual(store.projectsForRepository(["/unknown"]), []);

  store.putProject(
    project("alpha", { repositories: ["/r/new"], planRevision: 4 }),
  );
  assert.equal(store.project(key("alpha"))?.planRevision, 4);
  assert.deepEqual(
    store.projectsForRepository(["/r/a"]).map((p) => p.key),
    [],
  );
  assert.deepEqual(
    store.projectsForRepository(["/r/new"]).map((p) => p.key),
    ["alpha"],
  );
});

test("sessions: lookups by id, external identity and project", (t) => {
  const store = openStore(t);
  const one = sessionRow("s1");
  const two = sessionRow("s2", {
    externalSessionId: "ext-s1",
    vendor: "openai",
    runtime: "codex",
    createdAt: "2026-01-02T00:00:00.000Z",
    parentSessionId: session("s1"),
    effort: "high",
  });
  const other = sessionRow("s3", { projectKey: key("beta") });
  store.putSession(one);
  store.putSession(two);
  store.putSession(other);
  assert.deepEqual(store.session(session("s2")), two);
  assert.equal(store.session(session("missing")), undefined);
  assert.deepEqual(
    store.sessionByExternal("anthropic", "claude-code", "ext-s1"),
    one,
  );
  assert.equal(
    store.sessionByExternal("anthropic", "codex", "ext-s1"),
    undefined,
  );
  assert.equal(store.sessionByExternalId("ext-s1")?.id, "s2");
  assert.equal(store.sessionByExternalId("nope"), undefined);
  assert.deepEqual(
    store.sessions(key("alpha")).map((s) => s.id),
    ["s1", "s2"],
  );
  store.putSession({
    ...one,
    acknowledgedPlanRevision: 3,
    acknowledgedAt: "x",
  });
  assert.equal(store.session(session("s1"))?.acknowledgedPlanRevision, 3);
  assert.equal(store.sessions(key("alpha")).length, 2);
});

test("work: lookups by id, issue, session, and open filter", (t) => {
  const store = openStore(t);
  const a = workRow("w1");
  const b = workRow("w2", {
    status: "complete",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  const c = workRow("w3", {
    issueId: "issue-2",
    sessionId: session("s2"),
    status: "conflict",
    blocker: "merge",
    commit: "deadbeef",
    integrationRequired: true,
    predecessorWorkId: work("w1"),
    createdAt: "2026-01-03T00:00:00.000Z",
  });
  const d = workRow("w4", { status: "abandoned", issueId: "issue-3" });
  const e = workRow("w5", { status: "awaiting_integration", issueId: "i4" });
  for (const row of [a, b, c, d, e]) store.putWork(row);
  assert.deepEqual(store.work(work("w3")), c);
  assert.equal(store.work(work("zzz")), undefined);
  assert.deepEqual(
    store.workForIssue(key("alpha"), "issue-1").map((w) => w.id),
    ["w1", "w2"],
  );
  assert.deepEqual(
    store.openWork(key("alpha")).map((w) => w.id),
    ["w1", "w5", "w3"],
  );
  assert.deepEqual(store.openWork(key("beta")), []);
  assert.deepEqual(
    store.workForSession(session("s2")).map((w) => w.id),
    ["w3"],
  );
  store.putWork({ ...a, status: "released", revision: 2 });
  assert.equal(store.work(work("w1"))?.revision, 2);
  assert.deepEqual(
    store.openWork(key("alpha")).map((w) => w.id),
    ["w5", "w3"],
  );
});

test("receipts: round trip, replacement and pruning by age", (t) => {
  let clock = new Date("2026-03-01T00:00:00.000Z");
  const store = openStore(t, tempFile(t), () => clock);
  assert.equal(store.receipt("work_update", "r1"), undefined);
  store.putReceipt("work_update", "r1", "hash-1", { ok: true, list: [1, 2] });
  store.putReceipt("work_update", "r-null", "hash-n", undefined);
  assert.deepEqual(store.receipt("work_update", "r1"), {
    inputHash: "hash-1",
    result: { ok: true, list: [1, 2] },
  });
  assert.equal(store.receipt("other_scope", "r1"), undefined);
  assert.equal(store.receipt("work_update", "r-null")?.result, null);

  clock = new Date("2026-03-20T00:00:00.000Z");
  store.putReceipt("work_update", "r2", "hash-2", "fresh");
  clock = new Date("2026-03-31T00:00:00.000Z");
  store.pruneReceipts(30);
  assert.ok(store.receipt("work_update", "r1"), "30 days old is kept");
  clock = new Date("2026-04-05T00:00:00.000Z");
  store.pruneReceipts(30);
  assert.equal(store.receipt("work_update", "r1"), undefined);
  assert.equal(store.receipt("work_update", "r-null"), undefined);
  assert.equal(store.receipt("work_update", "r2")?.result, "fresh");
  store.putReceipt("work_update", "r2", "hash-3", "replaced");
  assert.deepEqual(store.receipt("work_update", "r2"), {
    inputHash: "hash-3",
    result: "replaced",
  });
});

test("journal: revisions are stored per project and replaceable", (t) => {
  const store = openStore(t);
  const row: JournalRevision = {
    projectKey: key("alpha"),
    revision: 2,
    sessionId: session("s1"),
    createdAt: "2026-01-05T00:00:00.000Z",
    tasks: [
      {
        key: "t1",
        issueId: "issue-1",
        identifier: "TA-1",
        title: "First",
        definition: { goal: "g", criteria: ["a", "b"] },
      },
    ],
    policy: { rules: [] },
    plan: { project: { name: "Alpha" } },
  };
  assert.equal(store.revision(key("alpha"), 2), undefined);
  store.putRevision(row);
  store.putRevision({ ...row, revision: 3, sessionId: null, policy: null });
  assert.deepEqual(store.revision(key("alpha"), 2), row);
  assert.equal(store.revision(key("alpha"), 3)?.policy, null);
  assert.equal(store.revision(key("beta"), 2), undefined);
  store.putRevision({ ...row, tasks: [] });
  assert.deepEqual(store.revision(key("alpha"), 2)?.tasks, []);
});

test("issue cache upserts by id and is scoped by project", (t) => {
  const store = openStore(t);
  assert.deepEqual(store.cachedIssues(key("alpha")), []);
  store.cacheIssues(key("alpha"), [issue("1"), issue("2")]);
  store.cacheIssues(key("beta"), [issue("9")]);
  store.cacheIssues(key("alpha"), [
    issue("2", { title: "Renamed", updatedAt: "2026-01-09T00:00:00.000Z" }),
    issue("3", { estimate: 3, dueDate: "2026-02-01", stateType: "completed" }),
  ]);
  const cached = store.cachedIssues(key("alpha"));
  assert.deepEqual(
    cached.map((i) => i.id),
    ["1", "3", "2"],
  );
  assert.equal(cached.find((i) => i.id === "2")?.title, "Renamed");
  assert.equal(cached.find((i) => i.id === "3")?.estimate, 3);
  assert.equal(store.cachedIssues(key("beta")).length, 1);
});

test("outbox is FIFO, pending skips sent rows, failures count attempts", (t) => {
  const store = openStore(t);
  const first = store.enqueue({
    projectKey: key("alpha"),
    kind: "comment",
    payload: { id: "c1", body: "hello" },
  });
  const second = store.enqueue({
    projectKey: null,
    kind: "add_label",
    payload: { issueId: "i", labelId: "l" },
  });
  const third = store.enqueue({
    projectKey: key("alpha"),
    kind: "update_issue",
    payload: { issueId: "i" },
  });
  assert.ok(first < second && second < third);
  assert.deepEqual(
    store.pending(10).map((r) => r.id),
    [first, second, third],
  );
  assert.deepEqual(
    store.pending(2).map((r) => r.id),
    [first, second],
  );
  const head = store.pending(1)[0];
  assert.equal(head?.kind, "comment");
  assert.deepEqual(head?.payload, { id: "c1", body: "hello" });
  assert.equal(head?.attempts, 0);
  assert.equal(head?.lastError, null);
  assert.equal(store.pending(10)[1]?.projectKey, null);

  store.markFailed(first, "rate limited");
  store.markFailed(first, "network down");
  const failed = store.pending(10)[0];
  assert.equal(failed?.id, first);
  assert.equal(failed?.attempts, 2);
  assert.equal(failed?.lastError, "network down");

  store.markSent(first);
  assert.deepEqual(
    store.pending(10).map((r) => r.id),
    [second, third],
  );
  store.markSent(second);
  store.markSent(third);
  assert.deepEqual(store.pending(10), []);
});

test("transaction commits, rolls back on throw, and nests", (t) => {
  const store = openStore(t);
  const result = store.transaction(() => {
    store.putProject(project("alpha"));
    return store.transaction(() => {
      store.putProject(project("beta"));
      return 7;
    });
  });
  assert.equal(result, 7);
  assert.ok(store.project(key("beta")));

  assert.throws(
    () =>
      store.transaction(() => {
        store.putProject(project("gamma"));
        store.transaction(() => store.putProject(project("delta")));
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(store.project(key("gamma")), undefined);
  assert.equal(store.project(key("delta")), undefined);

  store.transaction(() => {
    assert.throws(() =>
      store.transaction(() => {
        store.putProject(project("inner"));
        throw new Error("inner failed");
      }),
    );
    store.putProject(project("outer"));
  });
  assert.equal(store.project(key("inner")), undefined);
  assert.ok(store.project(key("outer")));
  assert.throws(
    () => store.transaction(() => Promise.resolve(1)),
    /synchronous/,
  );
  assert.equal(store.project(key("alpha"))?.key, "alpha");
});

test("two stores on one file: every interleaved transaction commits, none lost", (t) => {
  const path = tempFile(t);
  const left = openStore(t, path);
  const right = openStore(t, path);
  left.putProject(project("counter", { planRevision: 0 }));
  for (let round = 0; round < 25; round++)
    for (const store of [left, right])
      store.transaction(() => {
        const current = store.project(key("counter"));
        assert.ok(current);
        store.putProject({
          ...current,
          planRevision: current.planRevision + 1,
        });
      });
  assert.equal(left.project(key("counter"))?.planRevision, 50);
  assert.equal(right.project(key("counter"))?.planRevision, 50);
  left.putWork(workRow("from-left"));
  assert.ok(right.work(work("from-left")));
});

test("separate processes writing one file both commit without lost updates", async (t) => {
  const path = tempFile(t);
  openStore(t, path).putProject(project("counter", { planRevision: 0 }));
  const script = `
    import { SqliteLocalStore } from ${JSON.stringify(join(import.meta.dir, "../src/local/store.ts"))};
    const store = new SqliteLocalStore(process.argv[1]);
    for (let i = 0; i < 40; i++)
      store.transaction(() => {
        const row = store.project("counter");
        store.putProject({ ...row, planRevision: row.planRevision + 1 });
      });
    store.close();
  `;
  const children = [0, 1].map(() =>
    Bun.spawn(["bun", "-e", script, path], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const outcomes = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.stderr);
  const store = openStore(t, path);
  assert.equal(store.project(key("counter"))?.planRevision, 80);
});

test("verification entries append and query through the adapter", (t) => {
  const store = openStore(t);
  const access = store.verificationAccess();
  const body: VerdictBody = {
    battery_id: "stop_reason",
    battery_version: 1,
    run_id: "run-1",
    source: "jev",
    outcome: "failed",
    reason: "no evidence",
    decision: { done: false },
    readings: [],
    thresholds: { pass: 0.5 },
    judged_by: null,
    input: { text: "x" },
  };
  const verdictId = appendEntry(
    access,
    { projectId: "alpha", taskId: "t1", workId: "w1", sessionId: "s1" },
    { kind: "verdict", body },
  );
  const orphanId = appendEntry(
    access,
    { projectId: null },
    { kind: "verdict", body: { ...body, outcome: "passed" } },
  );
  appendEntry(
    access,
    { projectId: "alpha", taskId: "t1" },
    {
      kind: "label",
      body: { verdict_id: verdictId, right: true, note: "agreed" },
    },
  );
  appendEntry(
    access,
    { projectId: "alpha", workId: "w1" },
    { kind: "report", body: { action: "progress", status: "ok", report: "r" } },
  );

  const all = queryEntries(access);
  assert.deepEqual(
    all.map((e) => e.kind),
    ["verdict", "verdict", "label", "report"],
  );
  assert.equal(all[0]?.id, verdictId);
  assert.equal(queryEntries(access, { projectId: null })[0]?.id, orphanId);
  assert.equal(queryEntries(access, { taskIds: ["t1"] }).length, 2);
  assert.equal(
    queryEntries(access, { kinds: ["report"], newest: true, limit: 1 }).length,
    1,
  );
  const labels = labelsByVerdict(all);
  assert.equal(labels.get(verdictId)?.right, true);

  assert.throws(
    () => access.execute("UPDATE verifications SET source = 'x'", []),
    /history is immutable/,
  );
  assert.throws(
    () => access.execute("DELETE FROM verifications", []),
    /history is immutable/,
  );

  store.transaction(() => {
    appendEntry(access, { projectId: "beta" }, { kind: "verdict", body });
  });
  assert.equal(queryEntries(access, { projectId: "beta" }).length, 1);
  assert.throws(() =>
    store.transaction(() => {
      appendEntry(access, { projectId: "gamma" }, { kind: "verdict", body });
      throw new Error("undo");
    }),
  );
  assert.equal(queryEntries(access, { projectId: "gamma" }).length, 0);
});

test("events: added once per dedupe key, listed until cleared", (t) => {
  const store = openStore(t);
  const base: Omit<EventRow, "id" | "createdAt" | "clearedAt"> = {
    projectKey: key("alpha"),
    kind: "reopened",
    issueId: "issue-1",
    identifier: "TA-1",
    workId: null,
    dedupe: "reopened:issue-1:1",
    body: { reason: "left done" },
  };
  assert.equal(store.addEvent(base), true);
  assert.equal(store.addEvent(base), false);
  assert.equal(
    store.addEvent({ ...base, kind: "recheck", dedupe: "recheck:1" }),
    true,
  );
  const open = store.events(key("alpha"));
  assert.deepEqual(
    open.map((event) => [event.kind, event.identifier, event.body["reason"]]),
    [
      ["reopened", "TA-1", "left done"],
      ["recheck", "TA-1", "left done"],
    ],
  );
  assert.deepEqual(
    store
      .events(key("alpha"), { kinds: ["recheck"] })
      .map((event) => event.kind),
    ["recheck"],
  );
  store.clearEvent(open[0]?.id ?? 0);
  assert.equal(store.events(key("alpha")).length, 1);
  assert.equal(store.events(key("alpha"), { all: true }).length, 2);
});
