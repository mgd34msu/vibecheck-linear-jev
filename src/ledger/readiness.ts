// Whether a plan is ready for Linear.
//
// Until a plan has once passed readiness (the project's `readyAt`, also
// recorded in the machine map), every plan write writes nothing to Linear
// until every plan-time check passes: completeness (every fillable field,
// the recommended Kind and Area groups), plan-detail, task-duplicate,
// plan-coverage and brief-scope. A managed issue_adopt is gated the same way
// meanwhile, but passing its gate does not ready the plan. Each problem has
// a stable id (a check's problem ends with its outcome); a request may accept
// problems by id, and only when every problem is fixed or accepted does the
// write run. A judgment source that cannot answer never lets its checks pass
// silently: its problems are `unavailable` and block until accepted. Plan
// writes after the plan passed are not gated; their warnings are returned
// and posted to Linear.

import { BoardError } from "../errors.js";
import { describeEntry, type PendingEntry } from "../verification/ledger.js";

/** Fields left empty, per object. */
export interface Completeness {
  project?: string[];
  milestones?: Record<string, string[]>;
  tasks?: Record<string, string[]>;
  /** Structure the plan leaves out that most plans want. */
  recommended?: { label_groups?: string[] };
}

/** One thing a plan-time check found. */
export interface PlanProblem {
  /** Stable while the problem stays the same: what `accept` names. */
  readonly id: string;
  readonly check: string;
  /** `project`, `milestone`, `task`, `label_groups` or `plan`. */
  readonly object: string;
  readonly key?: string;
  readonly field?: string;
  /** `missing` for completeness, else the check's outcome. */
  readonly outcome: string;
  readonly reason: string;
}

/** Problems of the completeness check. */
export function completenessProblems(
  completeness: Completeness,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const field of completeness.project ?? [])
    problems.push({
      id: `completeness:project.${field}`,
      check: "completeness",
      object: "project",
      field,
      outcome: "missing",
      reason: `the project's ${field} is empty`,
    });
  for (const [code, fields] of Object.entries(completeness.milestones ?? {}))
    for (const field of fields)
      problems.push({
        id: `completeness:milestones.${code}.${field}`,
        check: "completeness",
        object: "milestone",
        key: code,
        field,
        outcome: "missing",
        reason: `milestone ${code} has no ${field}`,
      });
  for (const [key, fields] of Object.entries(completeness.tasks ?? {}))
    for (const field of fields)
      problems.push({
        id: `completeness:tasks.${key}.${field}`,
        check: "completeness",
        object: "task",
        key,
        field,
        outcome: "missing",
        reason: `task ${key} has no ${field}`,
      });
  // `recommended` (the Kind and Area label groups) is advice: it stays in
  // the completeness report and never holds a publish.
  return problems;
}

/** Problems among plan-time check entries: anything that did not pass. */
export function entryProblems(pending: readonly PendingEntry[]): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const { subject, entry } of pending) {
    if (entry.kind !== "verdict" && entry.kind !== "unavailable") continue;
    const { check, outcome, reason } = describeEntry(entry);
    if (outcome === "passed") continue;
    const taskKey = subject.taskId ?? undefined;
    const ref = entry.body.evidence?.ref ?? "";
    // A task-duplicate pair names both tasks, sorted, so the pair has one id
    // whichever task the check read first; plan-wide checks name the plan.
    // The outcome ends the id: an unavailable reading and a later flag of
    // the same subject are different problems, accepted separately.
    const suffix =
      taskKey === undefined
        ? "plan"
        : ref.startsWith("task:") && ref !== `task:${taskKey}`
          ? `tasks.${[taskKey, ref.slice("task:".length)].sort().join(".")}`
          : `tasks.${taskKey}`;
    problems.push({
      id: `${check}:${suffix}:${outcome}`,
      check,
      object: taskKey === undefined ? "plan" : "task",
      ...(taskKey === undefined ? {} : { key: taskKey }),
      outcome,
      reason,
    });
  }
  return problems;
}

/** The problem a missing judgment source raises: its checks never pass silently. */
export const JUDGMENT_UNAVAILABLE: PlanProblem = {
  id: "judgment:unavailable",
  check: "judgment",
  object: "plan",
  outcome: "unavailable",
  reason:
    "no judgment source is configured or usable, so task-duplicate, plan-coverage and brief-scope could not read the plan",
};

/**
 * Splits problems into the ones `accept` names and the ones still blocking.
 * An accepted id that names no current problem is `invalid`.
 */
export function applyAccept(
  problems: readonly PlanProblem[],
  accept: readonly string[],
): { readonly blocking: PlanProblem[]; readonly accepted: PlanProblem[] } {
  const ids = new Set(problems.map((problem) => problem.id));
  const unknown = accept.filter((id) => !ids.has(id));
  if (unknown.length > 0)
    throw new BoardError(
      "invalid",
      `accept names problems this plan does not have: ${unknown.join(", ")}`,
      unknown.map((id) => ({
        field: ["accept"],
        message: `unknown problem id ${id}`,
        type: "accept",
      })),
    );
  const wanted = new Set(accept);
  return {
    blocking: problems.filter((problem) => !wanted.has(problem.id)),
    accepted: problems.filter((problem) => wanted.has(problem.id)),
  };
}

export const NOT_READY_MESSAGE =
  "The plan is not ready for Linear, so nothing was written and no plan revision was recorded. Fix each problem in the plan, or accept it by id in `accept`, then send the request again (the same request_id may be reused).";
