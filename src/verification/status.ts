// What status shows from verification history and the reconciler: each task
// as reported (its Linear state) and as verified (its latest done check), and
// an attention list that leads the response with what needs a person or an
// agent now. Besides verdicts, the list carries what the reconciler found in
// Linear: issues reopened or removed, held completions a person moved to
// done anyway, people's replies on claimed issues,
// queued state moves skipped because a person moved the issue first, and
// open issues whose descriptions hold no acceptance criteria. A task counts as
// verified only when its latest done run includes a passing claims-done and
// no done check in it (done-admits-unfinished among them) failed or went
// unread. Which run counts follows one rule on every machine
// (src/ledger/verdicts.ts): the local run above the issue's verdict floor,
// else the tool's verdict labels in Linear; a task that is not complete
// never reads verified.

import { z } from "zod";
import type { EventRow, WorkRow } from "../local/types.js";
import type { SqlAccess } from "../sqlite.js";
import { queryEntries, type Entry, type VerdictEntry } from "./store.js";

export const attentionItemSchema = z.strictObject({
  kind: z.enum([
    "held_done",
    "held_done_moved",
    "blocker",
    "human_reply",
    "reopened",
    "removed",
    "skipped_move",
    "write_dropped",
    "stalled",
    "overlap",
    "unverified_done",
    "flag",
    "missing_standard",
  ]),
  check: z.string(),
  reason: z.string(),
  entry_id: z.string(),
  at: z.string(),
  task_id: z.string().optional(),
  work_id: z.string().optional(),
  needs: z.string().optional(),
  urgency: z.string().optional(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const taskVerificationSchema = z.strictObject({
  reported: z.string(),
  verified: z.enum(["verified", "held", "unverified"]),
  reason: z.string(),
  entry_id: z.string(),
  at: z.string(),
});
export type TaskVerification = z.infer<typeof taskVerificationSchema>;

export const DONE_CHECK_IDS = new Set([
  "vibecheck.claims-done",
  "vibecheck.done-admits-unfinished",
  "vibecheck.parent-rollup",
  "vibecheck.commit-paths",
  "vibecheck.exception-check",
]);

/** Flag checks a done report runs; their flags stay in attention after the work completes. */
const DONE_FLAG_CHECKS = new Set(["vibecheck.commit-honesty"]);

/**
 * The verdict of one done run (the done-check entries written together):
 * `held` when any failed (a done-admits-unfinished block among them),
 * `verified` only when claims-done itself ran and passed and nothing was left
 * for review or unreadable, else `unverified`.
 * `cause` is the entry that decided it, absent when claims-done did not run.
 */
export function doneRunVerdict(run: readonly Entry[]): {
  readonly verified: TaskVerification["verified"];
  readonly cause: Entry | undefined;
  readonly reason: string;
} {
  const failed = run.find(
    (entry) => entry.kind === "verdict" && entry.body.outcome === "failed",
  );
  // A failed re-check of an issue people moved to done does not hold
  // anything open: the task reads unverified.
  if (failed !== undefined)
    return {
      verified:
        failed.kind === "verdict" && failed.body.source === "ledger:reconcile"
          ? "unverified"
          : "held",
      cause: failed,
      reason: entryReason(failed),
    };
  const doubtful = run.find(
    (entry) =>
      entry.kind === "unavailable" ||
      (entry.kind === "verdict" && entry.body.outcome === "review"),
  );
  if (doubtful !== undefined)
    return {
      verified: "unverified",
      cause: doubtful,
      reason: entryReason(doubtful),
    };
  const claimsDone = run.find(
    (entry) =>
      entry.kind === "verdict" &&
      entry.body.battery_id === "vibecheck.claims-done" &&
      entry.body.outcome === "passed",
  );
  if (claimsDone === undefined)
    return {
      verified: "unverified",
      cause: undefined,
      reason:
        "claims-done did not run on this done report, so completion was not verified",
    };
  return {
    verified: "verified",
    cause: claimsDone,
    reason: entryReason(claimsDone),
  };
}

function entryReason(entry: Entry): string {
  if (entry.kind === "verdict") return entry.body.reason;
  if (entry.kind === "unavailable")
    return `reading unavailable: ${entry.body.error}`;
  return "";
}

const FLAG_CHECKS = new Set([
  "vibecheck.stop-reason",
  "vibecheck.deferral",
  "vibecheck.gives-up",
  "vibecheck.handoff-complete",
  "vibecheck.commit-honesty",
  "vibecheck.brief-scope",
  "vibecheck.task-duplicate",
  "vibecheck.plan-coverage",
  "vibecheck.plan-detail",
]);

const OPEN_WORK = new Set(["in_progress", "blocked", "awaiting_integration"]);
const MAX_ITEMS = 50;
const REASON_LIMIT = 300;

function clip(text: string): string {
  return text.length > REASON_LIMIT
    ? `${text.slice(0, REASON_LIMIT)}...`
    : text;
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const field = Object.entries(value).find(([name]) => name === key)?.[1];
  return typeof field === "string" ? field : undefined;
}

/** A task as status reads it. */
export interface StatusTask {
  readonly key: string;
  readonly identifier: string;
  readonly status: string;
  readonly hasStandard: boolean;
  readonly updatedAt: string;
  /** When the issue last reached a completed state. */
  readonly completedAt?: string | null;
  /**
   * The verdict the tool's labels record in Linear (`vc:verified`,
   * `vc:unverified`, `vc:held`), any machine's; undefined without one.
   */
  readonly linearVerdict?: TaskVerification["verified"];
  /**
   * The issue's verdict floor (a verification seq): local done entries at or
   * below it belong to an earlier completion and do not count.
   */
  readonly floor?: number;
  /** This machine's own completion of the issue is pending in Linear. */
  readonly completing?: boolean;
}

/** The verdict the tool's labels on an issue record; undefined when none does. */
export function labelVerdict(
  labels: readonly string[],
): TaskVerification["verified"] | undefined {
  const names = new Set(labels.map((label) => label.toLowerCase()));
  if (names.has("vc:unverified")) return "unverified";
  if (names.has("vc:held")) return "held";
  if (names.has("vc:verified")) return "verified";
  return undefined;
}

/** The verdict label that records `outcome`. */
const LABEL_OF: Readonly<Record<string, string>> = {
  verified: "vc:verified",
  unverified: "vc:unverified",
  held: "vc:held",
};

/**
 * Whether an issue's verdict labels (lowercase names) are explained by the
 * local outcome: none of them, or the one the local outcome itself writes.
 * Anything else is another machine's newer verdict.
 */
export function labelsExplained(
  names: ReadonlySet<string>,
  local: TaskVerification["verified"] | undefined,
): boolean {
  const verdictLabels = ["vc:verified", "vc:unverified", "vc:held"].filter(
    (name) => names.has(name),
  );
  if (verdictLabels.length === 0) return true;
  return local !== undefined && names.has(LABEL_OF[local] ?? "");
}

/**
 * The verdict of one task by the rule above: a task that is not complete
 * (and has no completion of this machine pending) never reads verified;
 * local done entries above the floor speak first; otherwise the verdict
 * labels do (`vc:held` on a complete issue reads unverified, as a person
 * moved held work to done).
 */
export function taskVerdict(
  status: string,
  local: TaskVerification["verified"] | undefined,
  label: TaskVerification["verified"] | undefined,
  completing = false,
): TaskVerification["verified"] | undefined {
  const complete = status === "complete" || completing;
  if (local !== undefined)
    return complete || local !== "verified" ? local : undefined;
  if (label === undefined) return undefined;
  if (complete) return label === "held" ? "unverified" : label;
  return label === "held" ? "held" : undefined;
}

export interface VerificationView {
  readonly attention: AttentionItem[];
  readonly tasks: Map<string, TaskVerification>;
}

export interface ViewInput {
  readonly projectKey: string;
  /** Tasks by plan key. */
  readonly tasks: ReadonlyMap<string, StatusTask>;
  readonly openWork: readonly WorkRow[];
  /** Uncleared reconciler events. */
  readonly events: readonly EventRow[];
}

/** Reads recent verification history and reconciler events into status fields. */
export function verificationView(
  access: SqlAccess,
  input: ViewInput,
): VerificationView {
  const { tasks } = input;
  const alias = new Map<string, string>();
  for (const task of tasks.values()) {
    alias.set(task.key, task.key);
    alias.set(task.identifier, task.key);
  }
  const keyOf = (id: string | null) =>
    id === null ? undefined : alias.get(id);
  const entries = queryEntries(access, {
    projectId: input.projectKey,
    kinds: ["verdict", "unavailable"],
    newest: true,
    limit: 2000,
  });
  const view: VerificationView = { attention: [], tasks: new Map() };
  const work = new Map<string, WorkRow>(
    input.openWork.map((record) => [record.id, record]),
  );
  const workOpen = (id: string | null) =>
    id !== null && OPEN_WORK.has(work.get(id)?.status ?? "");
  const item = (
    kind: AttentionItem["kind"],
    entry: VerdictEntry,
    extra: Partial<AttentionItem> = {},
  ): AttentionItem => {
    const key = keyOf(entry.task_id) ?? entry.task_id;
    return {
      kind,
      check: entry.body.battery_id,
      reason: clip(entry.body.reason),
      entry_id: entry.id,
      at: entry.created_at,
      ...(key === null || key === undefined ? {} : { task_id: key }),
      ...(entry.work_id === null ? {} : { work_id: entry.work_id }),
      ...extra,
    };
  };
  const verdicts = entries.filter(
    (entry): entry is VerdictEntry => entry.kind === "verdict",
  );

  // Each task's latest done check above its verdict floor: every done
  // verdict written with it. Entries at or below the floor belong to an
  // earlier completion (the issue was reopened, completed elsewhere, claimed
  // again, or another machine's verdict label came since).
  const doneGroups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = keyOf(entry.task_id);
    if (key === undefined) continue;
    const isDone =
      (entry.kind === "verdict" || entry.kind === "unavailable") &&
      DONE_CHECK_IDS.has(entry.body.battery_id);
    if (!isDone) continue;
    if (entry.seq <= (tasks.get(key)?.floor ?? 0)) continue;
    const group = doneGroups.get(key);
    if (group === undefined) doneGroups.set(key, [entry]);
    else if (group[0]?.created_at === entry.created_at) group.push(entry);
  }
  const held: AttentionItem[] = [];
  const unverified: AttentionItem[] = [];
  const unverifiedFromLinear: AttentionItem[] = [];
  // One rule per task (src/ledger/verdicts.ts): local entries of the
  // current completion first, else Linear's labels; a task that is not
  // complete never reads verified.
  for (const task of tasks.values()) {
    const taskKey = task.key;
    const group = doneGroups.get(taskKey);
    const first = group?.[0];
    const local = group === undefined ? undefined : doneRunVerdict(group);
    const verified = taskVerdict(
      task.status,
      local?.verified,
      task.linearVerdict,
      task.completing === true,
    );
    if (verified === undefined) continue;
    if (local === undefined || first === undefined) {
      const at = task.completedAt ?? task.updatedAt;
      const reason = `Linear's labels record this task as ${verified} (a verdict of another machine, or newer than this machine's entries)`;
      view.tasks.set(taskKey, {
        reported: task.status,
        verified,
        reason,
        entry_id: `issue:${task.identifier}`,
        at,
      });
      if (task.status === "complete" && verified !== "verified")
        unverifiedFromLinear.push({
          kind: "unverified_done",
          check: "vibecheck.claims-done",
          reason,
          entry_id: `issue:${task.identifier}`,
          at,
          task_id: taskKey,
        });
      continue;
    }
    const source = local.cause ?? first;
    view.tasks.set(taskKey, {
      reported: task.status,
      verified,
      reason: clip(local.reason),
      entry_id: source.id,
      at: source.created_at,
    });
    if (
      verified === "held" &&
      task.status !== "complete" &&
      source.kind === "verdict"
    )
      held.push(item("held_done", source));
    if (
      task.status === "complete" &&
      verified !== "verified" &&
      (source.kind === "verdict" || source.kind === "unavailable")
    )
      unverified.push({
        kind: "unverified_done",
        check:
          local.cause === undefined
            ? "vibecheck.claims-done"
            : source.body.battery_id,
        reason: clip(local.reason),
        entry_id: source.id,
        at: source.created_at,
        task_id: taskKey,
      });
  }
  // The work and time of each task's latest done run, for done-time flags.
  const doneRun = new Map<string, { workId: string | null; at: string }>();
  for (const [taskKey, group] of doneGroups) {
    const first = group[0];
    if (first !== undefined)
      doneRun.set(taskKey, { workId: first.work_id, at: first.created_at });
  }

  const latest = new Map<string, VerdictEntry>();
  for (const entry of verdicts) {
    const key = `${entry.body.battery_id}|${entry.work_id ?? keyOf(entry.task_id) ?? entry.task_id ?? "plan"}|${entry.body.evidence?.ref ?? ""}`;
    if (!latest.has(key)) latest.set(key, entry);
  }
  const blockers: AttentionItem[] = [];
  const stalled: AttentionItem[] = [];
  const overlaps: AttentionItem[] = [];
  const flags: AttentionItem[] = [];
  let planFlagSeen = false;
  for (const entry of latest.values()) {
    const battery = entry.body.battery_id;
    if (battery === "vibecheck.blocker-triage") {
      if (
        entry.work_id === null ||
        work.get(entry.work_id)?.status !== "blocked"
      )
        continue;
      const needs = stringField(entry.body.decision, "needs");
      const urgency = stringField(entry.body.decision, "urgency");
      blockers.push(
        item("blocker", entry, {
          ...(needs === undefined ? {} : { needs }),
          ...(urgency === undefined ? {} : { urgency }),
        }),
      );
      continue;
    }
    if (entry.body.outcome !== "flagged") continue;
    if (battery === "vibecheck.stalled") {
      if (workOpen(entry.work_id)) stalled.push(item("stalled", entry));
      continue;
    }
    if (battery === "vibecheck.claim-overlap") {
      const other = entry.body.evidence?.ref.replace(/^work:/u, "") ?? null;
      if (workOpen(entry.work_id) && workOpen(other))
        overlaps.push(item("overlap", entry));
      continue;
    }
    if (!FLAG_CHECKS.has(battery)) continue;
    if (entry.work_id !== null) {
      const run = doneRun.get(keyOf(entry.task_id) ?? "");
      if (workOpen(entry.work_id)) flags.push(item("flag", entry));
      else if (
        DONE_FLAG_CHECKS.has(battery) &&
        run !== undefined &&
        run.workId === entry.work_id &&
        run.at === entry.created_at
      )
        flags.push(item("flag", entry));
    } else if (entry.task_id !== null) {
      const task = tasks.get(keyOf(entry.task_id) ?? "");
      if (
        task !== undefined &&
        task.status !== "complete" &&
        task.status !== "cancelled"
      )
        flags.push(item("flag", entry));
    } else if (!planFlagSeen) {
      planFlagSeen = true;
      flags.push(item("flag", entry));
    }
  }

  const eventItem = (event: EventRow): AttentionItem => {
    const key = alias.get(event.identifier) ?? event.identifier;
    const reason = stringField(event.body, "reason") ?? event.kind;
    return {
      kind:
        event.kind === "human_reply"
          ? "human_reply"
          : event.kind === "reopened"
            ? "reopened"
            : event.kind === "skipped_move"
              ? "skipped_move"
              : event.kind === "held_done_moved"
                ? "held_done_moved"
                : event.kind === "write_dropped"
                  ? "write_dropped"
                  : "removed",
      check: "linear",
      reason: clip(reason),
      entry_id: `event:${event.id}`,
      at: event.createdAt,
      task_id: key,
      ...(event.workId === null ? {} : { work_id: event.workId }),
    };
  };
  const replies = input.events
    .filter((event) => event.kind === "human_reply")
    .map(eventItem);
  const heldMoved = input.events
    .filter((event) => event.kind === "held_done_moved")
    .map(eventItem);
  const reopened = input.events
    .filter((event) => event.kind === "reopened")
    .map(eventItem);
  const removed = input.events
    .filter((event) => event.kind === "removed")
    .map(eventItem);
  const skippedMoves = input.events
    .filter((event) => event.kind === "skipped_move")
    .map(eventItem);
  const dropped = input.events
    .filter((event) => event.kind === "write_dropped")
    .map(eventItem);
  const missing: AttentionItem[] = [...tasks.values()]
    .filter(
      (task) =>
        !task.hasStandard &&
        task.status !== "complete" &&
        task.status !== "cancelled",
    )
    .map((task) => ({
      kind: "missing_standard",
      check: "linear",
      reason:
        "the issue description has no readable acceptance criteria (Done when), so done reports are judged on the description as a whole",
      entry_id: `issue:${task.identifier}`,
      at: task.updatedAt,
      task_id: task.key,
    }));

  const urgent = (entry: AttentionItem) =>
    entry.needs === "user" || entry.urgency === "high";
  const rank: Record<string, number> = { high: 0, normal: 1, low: 2 };
  blockers.sort(
    (left, right) =>
      Number(!urgent(left)) - Number(!urgent(right)) ||
      (rank[left.urgency ?? "low"] ?? 3) - (rank[right.urgency ?? "low"] ?? 3),
  );
  view.attention.push(
    ...held,
    ...heldMoved,
    ...blockers.filter(urgent),
    ...replies,
    ...reopened,
    ...removed,
    ...skippedMoves,
    ...dropped,
    ...stalled,
    ...overlaps,
    ...unverified,
    ...unverifiedFromLinear,
    ...flags,
    ...blockers.filter((entry) => !urgent(entry)),
    ...missing,
  );
  view.attention.splice(MAX_ITEMS);
  return view;
}
