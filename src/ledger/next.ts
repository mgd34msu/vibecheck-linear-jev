// `next` in project_status: a short ordered list of what the calling
// session should do now. First the attention items about its own work (its
// claims, past or open, and the tasks it holds), then its open claims with
// their status, then the next task it could claim: one nobody holds, whose
// dependencies are finished (complete or cancelled) and whose children (if
// any) are finished, taken in milestone order and then plan order. Without a
// session only the next available task is given. A task is unclaimed when
// its issue is not started in Linear, carries no `vc:claimed` and has no
// open claim here. An issue in Linear's triage state is never offered.
//
// Dependencies come from the issue's `Depends on` section, the plan map's
// `depends_on`, and Linear's `blocks` relations (looked up by the caller
// for the candidates, `blockers`); milestone order from the plan record's
// milestone list. A dependency that names no task of the project is not
// known to be finished, so the task waits. A cancelled dependency counts as
// finished, and the offered item names it (`cancelled_dependencies`) so the
// agent checks whether the task still needs what it would have provided.

import { z } from "zod";
import type { JournalRevision, WorkRow } from "../local/types.js";
import { OPEN_WORK } from "./access.js";
import type { TaskView } from "./snapshot.js";

/** The fields of an attention item `next` reads. */
export interface NextAttention {
  readonly kind: string;
  readonly reason: string;
  readonly entry_id: string;
  readonly task_id?: string | undefined;
  readonly work_id?: string | undefined;
}

export type NextItem =
  | {
      readonly kind: "attention";
      readonly attention: string;
      readonly task_id?: string;
      readonly work_id?: string;
      readonly reason: string;
      readonly entry_id: string;
      readonly do: string;
    }
  | {
      readonly kind: "claim";
      readonly task_id: string;
      readonly identifier: string;
      readonly work_id: string;
      readonly status: string;
      readonly verified?: string;
      readonly blocker?: string;
      readonly do: string;
    }
  | {
      readonly kind: "available";
      readonly task_id: string;
      readonly identifier: string;
      readonly title: string;
      readonly milestone?: string;
      readonly url: string;
      /** Dependencies (keys or identifiers) that were cancelled, not done. */
      readonly cancelled_dependencies?: readonly string[];
      readonly do: string;
    }
  | { readonly kind: "none_available"; readonly do: string };

export interface NextInput {
  /** The calling session; undefined gives only the next available task. */
  readonly sessionId: string | undefined;
  /** The status attention list, in its order. */
  readonly attention: readonly NextAttention[];
  /** Every work record of the session, open or not. */
  readonly sessionWork: readonly WorkRow[];
  /** The project's open work, every session's. */
  readonly openWork: readonly WorkRow[];
  readonly tasks: readonly TaskView[];
  readonly journal: JournalRevision | undefined;
  /** Verified status by task key, when a done check ran. */
  readonly verified: ReadonlyMap<string, string>;
  /**
   * Linear `blocks` relations of the candidates the caller looked up, by
   * issue id: the identifiers of blockers not finished, and of cancelled ones.
   */
  readonly blockers?: ReadonlyMap<string, Blockers>;
}

/** A candidate's `blocks` blockers, by whether they finished. */
export interface Blockers {
  readonly unfinished: readonly string[];
  readonly cancelled: readonly string[];
}

/** Own attention items listed at most. */
export const NEXT_ATTENTION_LIMIT = 10;

const ATTENTION_ACTIONS: Readonly<Record<string, string>> = {
  claim_lost: "stop working on this task: the claim was closed",
  completion_waiting:
    "repeat work_update with the request_id named and the same change",
  held_done: "fix what the reason names, then report done again",
  held_done_moved:
    "check the issue in Linear; fix what held the report, then report done again",
  blocker: "resolve the blocker or put it to whoever it needs",
  human_reply: "read the comment and answer it in your next report",
  reopened: "check the issue in Linear and continue the work",
  removed: "stop: the issue left the project and the work was abandoned",
  write_dropped: "make the change in Linear by hand if it is still wanted",
  skipped_move:
    "check the issue's state in Linear before reporting on it again",
  stalled: "report concrete progress, or release the claim with a report",
  overlap: "agree the split with the other claim's holder",
  unverified_done:
    "read the verdict in work_history and report what the check could not see",
  flag: "read the reason and fix what it names",
  missing_standard: "ask the coordinator for Done when criteria",
};

const CLAIM_ACTIONS: Readonly<Record<string, string>> = {
  in_progress:
    "continue, then report done with a report against each criterion",
  blocked: "work the blocker; report progress when it clears",
  awaiting_integration: "integrate the work, then report it done",
};

const planRecordSchema = z.looseObject({
  milestones: z.array(z.looseObject({ code: z.string() })).optional(),
  milestone_ids: z.record(z.string(), z.string()).optional(),
});
const definitionSchema = z.looseObject({
  depends_on: z.array(z.string()).optional(),
  milestone: z.string().optional(),
});

/** Milestone rank and code per task key, and plan order, from the plan record. */
function planOrder(journal: JournalRevision | undefined) {
  const record = planRecordSchema.safeParse(journal?.plan ?? {});
  // A machine that recovered the plan from Linear's plan document has the
  // milestone ids but no milestone list; the ids keep the plan's order.
  const listed = record.success
    ? (record.data.milestones ?? []).map((milestone) => milestone.code)
    : [];
  const codes =
    listed.length > 0
      ? listed
      : Object.keys(record.success ? (record.data.milestone_ids ?? {}) : {});
  const rankOfCode = new Map(codes.map((code, index) => [code, index]));
  const codeOfId = new Map(
    Object.entries(record.success ? (record.data.milestone_ids ?? {}) : {}).map(
      ([code, id]) => [id, code],
    ),
  );
  const definitions = new Map(
    (journal?.tasks ?? []).map((task, index) => {
      const parsed = definitionSchema.safeParse(task.definition);
      return [
        task.issueId,
        { index, definition: parsed.success ? parsed.data : {} },
      ];
    }),
  );
  const milestoneOf = (task: TaskView): string | undefined =>
    (task.milestoneId === null ? undefined : codeOfId.get(task.milestoneId)) ??
    definitions.get(task.issueId)?.definition.milestone;
  const rank = (task: TaskView): [number, number] => {
    const code = milestoneOf(task);
    return [
      code === undefined
        ? codes.length
        : (rankOfCode.get(code) ?? codes.length),
      definitions.get(task.issueId)?.index ?? Number.MAX_SAFE_INTEGER,
    ];
  };
  const dependencies = (task: TaskView): string[] => [
    ...(task.sections.depends_on ?? []).map((entry) => entry.identifier),
    ...(definitions.get(task.issueId)?.definition.depends_on ?? []),
  ];
  return { milestoneOf, rank, dependencies };
}

/** The ordered list of what to do now. */
export function nextSteps(input: NextInput): NextItem[] {
  const items: NextItem[] = [];
  const keyOf = new Map(input.tasks.map((task) => [task.issueId, task.key]));
  if (input.sessionId !== undefined) {
    const ownWork = new Set<string>(input.sessionWork.map((work) => work.id));
    const open = input.sessionWork.filter((work) => OPEN_WORK.has(work.status));
    const ownTasks = new Set(
      open.flatMap((work) => {
        const key = keyOf.get(work.issueId);
        return key === undefined ? [work.identifier] : [key, work.identifier];
      }),
    );
    const own = input.attention.filter(
      (item) =>
        (item.work_id !== undefined && ownWork.has(item.work_id)) ||
        (item.work_id === undefined &&
          item.task_id !== undefined &&
          ownTasks.has(item.task_id)),
    );
    for (const item of own.slice(0, NEXT_ATTENTION_LIMIT))
      items.push({
        kind: "attention",
        attention: item.kind,
        ...(item.task_id === undefined ? {} : { task_id: item.task_id }),
        ...(item.work_id === undefined ? {} : { work_id: item.work_id }),
        reason: item.reason,
        entry_id: item.entry_id,
        do: ATTENTION_ACTIONS[item.kind] ?? "read the reason and act on it",
      });
    for (const work of open) {
      const key = keyOf.get(work.issueId) ?? work.identifier;
      const verified = input.verified.get(key);
      items.push({
        kind: "claim",
        task_id: key,
        identifier: work.identifier,
        work_id: work.id,
        status: work.status,
        ...(verified === undefined ? {} : { verified }),
        ...(work.blocker === null ? {} : { blocker: work.blocker }),
        do: CLAIM_ACTIONS[work.status] ?? "report its status",
      });
    }
  }

  const plan = planOrder(input.journal);
  const candidates = nextCandidates(input);
  const offered = candidates.find(
    (task) =>
      (input.blockers?.get(task.issueId)?.unfinished ?? []).length === 0,
  );
  if (offered !== undefined) {
    const milestone = plan.milestoneOf(offered);
    const byRef = tasksByRef(input.tasks);
    // Each cancelled dependency once, by its key, however it was named.
    const cancelled = [
      ...new Set([
        ...plan.dependencies(offered).flatMap((ref) => {
          const task = byRef.get(ref) ?? byRef.get(ref.toUpperCase());
          return task?.status === "cancelled" ? [task.key] : [];
        }),
        ...(input.blockers?.get(offered.issueId)?.cancelled ?? []),
      ]),
    ];
    items.push({
      kind: "available",
      task_id: offered.key,
      identifier: offered.identifier,
      title: offered.title,
      ...(milestone === undefined ? {} : { milestone }),
      url: offered.url,
      ...(cancelled.length === 0 ? {} : { cancelled_dependencies: cancelled }),
      do:
        cancelled.length === 0
          ? "claim it with work_claim"
          : `claim it with work_claim; its dependency ${cancelled.join(", ")} was cancelled, not done, so check first whether the task still needs what it would have provided`,
    });
  } else if (!items.some((item) => item.kind === "claim"))
    items.push({
      kind: "none_available",
      do: "every open task is claimed or waits on a dependency or its children; ask the coordinator for work",
    });
  return items;
}

function tasksByRef(tasks: readonly TaskView[]): Map<string, TaskView> {
  const byRef = new Map<string, TaskView>();
  for (const task of tasks) {
    byRef.set(task.key, task);
    byRef.set(task.identifier.toUpperCase(), task);
  }
  return byRef;
}

/**
 * The tasks `next` could offer, best first, before Linear's `blocks`
 * relations are read: pending (not triage), unclaimed, every dependency and
 * child finished, in milestone order and then plan order.
 */
export function nextCandidates(
  input: Pick<NextInput, "openWork" | "tasks" | "journal">,
): TaskView[] {
  const held = new Set(
    input.openWork
      .filter((work) => OPEN_WORK.has(work.status))
      .map((work) => work.issueId),
  );
  const byRef = tasksByRef(input.tasks);
  const finished = (task: TaskView | undefined) =>
    task !== undefined &&
    (task.status === "complete" || task.status === "cancelled");
  const plan = planOrder(input.journal);
  // Unclaimed: not started in Linear (another machine's claim starts the
  // issue and labels it vc:claimed), and no open claim here.
  return input.tasks
    .filter(
      (task) =>
        task.status === "pending" &&
        task.stateType !== "triage" &&
        !task.labels.includes("vc:claimed") &&
        !held.has(task.issueId) &&
        plan
          .dependencies(task)
          .every((ref) =>
            finished(byRef.get(ref) ?? byRef.get(ref.toUpperCase())),
          ) &&
        input.tasks.every(
          (child) => child.parentIssueId !== task.issueId || finished(child),
        ),
    )
    .map((task, index) => ({ task, index, rank: plan.rank(task) }))
    .sort(
      (left, right) =>
        left.rank[0] - right.rank[0] ||
        left.rank[1] - right.rank[1] ||
        left.index - right.index,
    )
    .map(({ task }) => task);
}
