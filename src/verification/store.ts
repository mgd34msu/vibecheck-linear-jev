// Verification history: immutable rows beside the ledger's change stream.
//
//   verdict      a battery's reading on a task, claim, plan change or reply
//   unavailable  a reading that could not be taken (no source answered)
//   label        a person's judgment that a verdict was right or wrong
//   report       the text an agent reported with a work update
//
// Rows carry the project, task, work and session they concern when known.
// A verdict from a session outside any ledger project has no project.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { jsonValueSchema } from "../schemas.js";
import { encode, type SqlAccess, type SqlValue } from "../sqlite.js";

export const outcomeSchema = z.enum(["passed", "failed", "flagged", "review"]);
export type Outcome = z.infer<typeof outcomeSchema>;

export const readingSchema = z.strictObject({
  question_id: z.string(),
  type: z.enum(["noul", "choice", "score"]),
  value: z.union([z.number(), z.string()]),
  confidence: z.number().optional(),
  distribution: z.array(z.number()),
});
export type ReadingRecord = z.infer<typeof readingSchema>;

export const judgedBySchema = z.strictObject({
  source_id: z.string(),
  model: z.string(),
  provenance: z.string(),
  latency_ms: z.number(),
  input_tokens: z.number(),
  skipped: z
    .array(z.strictObject({ source_id: z.string(), reason: z.string() }))
    .optional(),
});
export type JudgedBy = z.infer<typeof judgedBySchema>;

export const evidenceSchema = z.strictObject({
  kind: z.string(),
  ref: z.string(),
  excerpt: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const verdictBodySchema = z.strictObject({
  battery_id: z.string(),
  battery_version: z.number().int(),
  run_id: z.string(),
  source: z.string(),
  outcome: outcomeSchema,
  reason: z.string(),
  decision: jsonValueSchema,
  readings: z.array(readingSchema),
  thresholds: z.record(z.string(), z.number()),
  /** Null when code decided with no reading, such as a commit that touched no claimed path. */
  judged_by: judgedBySchema.nullable(),
  input: jsonValueSchema,
  evidence: evidenceSchema.optional(),
  reported_status: z.string().optional(),
  applied_status: z.string().optional(),
  external_session_id: z.string().optional(),
  /** Imported history keeps the id it had before import. */
  imported_from: z.string().optional(),
});
export type VerdictBody = z.infer<typeof verdictBodySchema>;

export const unavailableBodySchema = z.strictObject({
  battery_id: z.string(),
  battery_version: z.number().int(),
  source: z.string(),
  error: z.string(),
  input: jsonValueSchema,
  evidence: evidenceSchema.optional(),
  external_session_id: z.string().optional(),
});
export type UnavailableBody = z.infer<typeof unavailableBodySchema>;

export const labelBodySchema = z.strictObject({
  verdict_id: z.string(),
  right: z.boolean(),
  note: z.string(),
  imported_from: z.string().optional(),
});
export type LabelBody = z.infer<typeof labelBodySchema>;

export const reportBodySchema = z.strictObject({
  action: z.enum(["progress", "release", "handoff"]),
  status: z.string(),
  report: z.string(),
  blocker: z.string().optional(),
});
export type ReportBody = z.infer<typeof reportBodySchema>;

const rowShape = {
  seq: z.number().int(),
  id: z.string(),
  project_id: z.string().nullable(),
  task_id: z.string().nullable(),
  work_id: z.string().nullable(),
  session_id: z.string().nullable(),
  battery_id: z.string().nullable(),
  source: z.string(),
  created_at: z.string(),
};

export const entrySchema = z.discriminatedUnion("kind", [
  z.object({
    ...rowShape,
    kind: z.literal("verdict"),
    body: verdictBodySchema,
  }),
  z.object({
    ...rowShape,
    kind: z.literal("unavailable"),
    body: unavailableBodySchema,
  }),
  z.object({ ...rowShape, kind: z.literal("label"), body: labelBodySchema }),
  z.object({ ...rowShape, kind: z.literal("report"), body: reportBodySchema }),
]);
export type Entry = z.infer<typeof entrySchema>;
export type VerdictEntry = Extract<Entry, { kind: "verdict" }>;
export type Kind = Entry["kind"];

const storedRowSchema = z
  .object({ ...rowShape, kind: z.string(), body: z.string() })
  .transform((row) =>
    entrySchema.parse({ ...row, body: JSON.parse(row.body) }),
  );

export interface Subject {
  readonly projectId: string | null;
  readonly taskId?: string | null;
  readonly workId?: string | null;
  readonly sessionId?: string | null;
}

export type NewEntry =
  | { readonly kind: "verdict"; readonly body: VerdictBody }
  | { readonly kind: "unavailable"; readonly body: UnavailableBody }
  | { readonly kind: "label"; readonly body: LabelBody }
  | { readonly kind: "report"; readonly body: ReportBody };

function sourceOf(entry: NewEntry): string {
  switch (entry.kind) {
    case "verdict":
    case "unavailable":
      return entry.body.source;
    case "label":
      return "label";
    case "report":
      return `report:${entry.body.action}`;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/** Appends one immutable entry and returns its id. */
export function appendEntry(
  access: SqlAccess,
  subject: Subject,
  entry: NewEntry,
  id = `${entry.kind.charAt(0)}_${randomUUID().replaceAll("-", "")}`,
): string {
  const batteryId =
    entry.kind === "verdict" || entry.kind === "unavailable"
      ? entry.body.battery_id
      : null;
  const body =
    entry.kind === "verdict"
      ? verdictBodySchema.parse(entry.body)
      : entry.kind === "unavailable"
        ? unavailableBodySchema.parse(entry.body)
        : entry.kind === "label"
          ? labelBodySchema.parse(entry.body)
          : reportBodySchema.parse(entry.body);
  access.execute(
    `INSERT INTO verifications(id, project_id, task_id, work_id, session_id, kind, battery_id, source, created_at, body)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      subject.projectId,
      subject.taskId ?? null,
      subject.workId ?? null,
      subject.sessionId ?? null,
      entry.kind,
      batteryId,
      sourceOf(entry),
      access.now,
      encode(body),
    ],
  );
  return id;
}

export interface EntryFilter {
  /** A project id, or null for entries outside any project. Omit for all. */
  readonly projectId?: string | null;
  readonly taskIds?: readonly string[];
  readonly workIds?: readonly string[];
  readonly sessionId?: string;
  readonly kinds?: readonly Kind[];
  readonly batteryId?: string;
  readonly source?: string;
  readonly idPrefix?: string;
  readonly after?: number;
  /** Newest first when true; oldest first otherwise. */
  readonly newest?: boolean;
  readonly limit?: number;
}

export function queryEntries(
  access: SqlAccess,
  filter: EntryFilter = {},
): Entry[] {
  const clauses: string[] = [];
  const values: SqlValue[] = [];
  if (filter.projectId === null) clauses.push("project_id IS NULL");
  else if (filter.projectId !== undefined) {
    clauses.push("project_id = ?");
    values.push(filter.projectId);
  }
  const listClause = (column: string, list: readonly string[] | undefined) => {
    if (list === undefined) return;
    clauses.push(`${column} IN (SELECT value FROM json_each(?))`);
    values.push(JSON.stringify(list));
  };
  if (filter.taskIds !== undefined && filter.workIds !== undefined) {
    clauses.push(
      "(task_id IN (SELECT value FROM json_each(?)) OR work_id IN (SELECT value FROM json_each(?)))",
    );
    values.push(JSON.stringify(filter.taskIds), JSON.stringify(filter.workIds));
  } else {
    listClause("task_id", filter.taskIds);
    listClause("work_id", filter.workIds);
  }
  listClause("kind", filter.kinds);
  if (filter.sessionId !== undefined) {
    clauses.push("session_id = ?");
    values.push(filter.sessionId);
  }
  if (filter.batteryId !== undefined) {
    clauses.push("battery_id = ?");
    values.push(filter.batteryId);
  }
  if (filter.source !== undefined) {
    clauses.push("source = ?");
    values.push(filter.source);
  }
  if (filter.idPrefix !== undefined) {
    clauses.push("substr(id, 1, ?) = ?");
    values.push(filter.idPrefix.length, filter.idPrefix);
  }
  if (filter.after !== undefined) {
    clauses.push("seq > ?");
    values.push(filter.after);
  }
  values.push(filter.limit ?? 1000);
  return access.queryRows(
    storedRowSchema,
    `SELECT seq, id, project_id, task_id, work_id, session_id, kind, battery_id, source, created_at, body
     FROM verifications ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
     ORDER BY seq ${filter.newest === true ? "DESC" : "ASC"} LIMIT ?`,
    values,
  );
}

/** The latest label per verdict: a later label corrects an earlier one. */
export function labelsByVerdict(
  entries: readonly Entry[],
): Map<string, LabelBody> {
  const labels = new Map<string, LabelBody>();
  for (const entry of entries)
    if (entry.kind === "label") labels.set(entry.body.verdict_id, entry.body);
  return labels;
}
