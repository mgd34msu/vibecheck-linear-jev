// Checks the ledger runs on what agents report to it.
//
//   work_update to complete   claims-done against the task's goal, criteria
//                             and accepted exceptions, done-admits-unfinished
//                             on the same report, plus the commit-path,
//                             data-only exception and parent roll-up checks,
//                             with linked pull requests as extra evidence;
//                             a failure keeps the task open (held)
//   work_update to blocked    stop-reason, deferral and blocker triage
//   release with a report     gives-up, stop-reason and deferral
//   handoff                   handoff-complete
//   progress with a report    stalled, once the claim has several updates
//   work_claim                claim-overlap against other open claims
//   plan_publish / plan_edit  brief-scope over the plan change, task-duplicate
//                             for added tasks, plan-coverage against the goal
//   issue_adopt, plans        plan-detail: vague goals and criteria (code)
//   reconciler                claims-done and done-admits-unfinished
//                             re-check of an issue a person moved to done
//
// Every check reads a Snapshot (src/ledger/snapshot.ts): the tasks as their
// Linear issues stand, the policy, the open work. Readings run outside any
// database transaction; `record` writes their entries to the local store.
// When no source answers, an "unavailable" entry is written instead of a
// verdict and the change is applied as reported.

import type { LinkedPullRequest } from "../linear/api.js";
import type { ProjectKey, WorkId, WorkRow } from "../local/types.js";
import type { WorkChange } from "../schemas.js";
import type { SqlAccess } from "../sqlite.js";
import {
  blockerTriageBattery,
  briefScopeBattery,
  claimOverlapBattery,
  claimsDoneBattery,
  commitHonestyBattery,
  deferralBattery,
  doneAdmitsUnfinishedBattery,
  givesUpBattery,
  handoffBattery,
  planCoverageBattery,
  stalledBattery,
  stopReasonBattery,
  taskDuplicateBattery,
} from "../jev/batteries.js";
import {
  checkDataOnlyPaths,
  readCommit,
  touchesPaths,
  type CommitInfo,
} from "../jev/code.js";
import {
  deterministicEntry,
  entryFor,
  type EntryContext,
} from "../jev/entries.js";
import { checkEnabled } from "../jev/config.js";
import { runCheck, type Judgment } from "../jev/judgment.js";
import {
  allowedReasonsText,
  exceptionsText,
  planText,
  taskText,
  workText,
  type StandardTask,
} from "../jev/standard.js";
import type { ProjectPolicy } from "../schemas.js";
import type { Snapshot, TaskView } from "../ledger/snapshot.js";
import { DONE_CHECK_IDS, doneRunVerdict } from "./status.js";
import {
  appendEntry,
  queryEntries,
  type NewEntry,
  type Outcome,
  type Subject,
} from "./store.js";

export interface VerificationItem {
  readonly check: string;
  readonly outcome: Outcome | "unavailable";
  readonly reason: string;
  readonly entry_id: string;
  readonly task_id?: string;
  readonly work_id?: string;
  readonly reported_status?: string;
  readonly applied_status?: string;
}

export interface PendingEntry {
  readonly subject: Subject;
  readonly entry: NewEntry;
}

/** One requested work change with what its checks read. */
export interface ChangeContext {
  readonly change: WorkChange;
  readonly work: WorkRow;
  readonly task: TaskView;
  /** The claim's earlier reports, oldest first, as `status: text`. */
  readonly previousReports: readonly string[];
  readonly children: readonly { key: string; verified: boolean }[];
  /** Pull requests Linear links to the issue; empty without a Git integration. */
  readonly pullRequests: readonly LinkedPullRequest[];
}

export interface WorkUpdatePlan {
  /** Work whose requested completion is held open, with the reason. */
  readonly holds: ReadonlyMap<WorkId, string>;
  readonly pending: readonly PendingEntry[];
}

/** A plan as the plan checks read it. */
export interface PlanView {
  readonly revision: number;
  readonly tasks: readonly StandardTask[];
  readonly policy: ProjectPolicy | undefined;
}

export const PLAN_DETAIL_CHECK = "vibecheck.plan-detail";

const STALL_AFTER = 3;
const OVERLAP_LIMIT = 8;
const DUPLICATE_PAIR_LIMIT = 30;

function requestedStatus(change: WorkChange, work: WorkRow): string {
  if (change.action === "release") return "released";
  if (change.action === "handoff") return work.status;
  return change.status ?? work.status;
}

/** The check, outcome and reason an entry will show once recorded. */
export function describeEntry(entry: NewEntry): {
  check: string;
  outcome: Outcome | "unavailable";
  reason: string;
} {
  switch (entry.kind) {
    case "verdict":
      return {
        check: entry.body.battery_id,
        outcome: entry.body.outcome,
        reason: entry.body.reason,
      };
    case "unavailable":
      return {
        check: entry.body.battery_id,
        outcome: "unavailable",
        reason: `reading unavailable: ${entry.body.error}`,
      };
    default:
      return { check: entry.kind, outcome: "passed", reason: "" };
  }
}

/**
 * Writes pending entries to the history and summarizes them for a tool
 * result. Every entry of one call carries the same timestamp, so the done
 * checks of one report read back as one run.
 */
export function recordEntries(
  access: SqlAccess,
  pending: readonly PendingEntry[],
): VerificationItem[] {
  const batch: SqlAccess = {
    now: access.now,
    queryRows: (schema, sql, values) => access.queryRows(schema, sql, values),
    execute: (sql, values) => access.execute(sql, values),
  };
  return pending.map(({ subject, entry }) => {
    const id = appendEntry(batch, subject, entry);
    const summary = describeEntry(entry);
    return {
      ...summary,
      entry_id: id,
      ...(subject.taskId == null ? {} : { task_id: subject.taskId }),
      ...(subject.workId == null ? {} : { work_id: subject.workId }),
      ...(entry.kind === "verdict" && entry.body.reported_status !== undefined
        ? { reported_status: entry.body.reported_status }
        : {}),
      ...(entry.kind === "verdict" && entry.body.applied_status !== undefined
        ? { applied_status: entry.body.applied_status }
        : {}),
    };
  });
}

/**
 * Whether the done checks among a call's results verify the completion:
 * claims-done ran and passed, and no done check (done-admits-unfinished among
 * them) failed, was left for review or could not be read (the rule of
 * `doneRunVerdict`).
 */
export function doneItemsVerified(
  items: readonly Pick<VerificationItem, "check" | "outcome">[],
): boolean {
  const done = items.filter((item) => DONE_CHECK_IDS.has(item.check));
  return (
    done.some(
      (item) =>
        item.check === "vibecheck.claims-done" && item.outcome === "passed",
    ) &&
    done.every(
      (item) =>
        item.outcome !== "failed" &&
        item.outcome !== "review" &&
        item.outcome !== "unavailable",
    )
  );
}

/** Evidence lines for linked pull requests; empty when there are none. */
export function pullRequestLines(prs: readonly LinkedPullRequest[]): string[] {
  return prs.map((pr) => {
    const name = `${pr.source === "gitlab" ? "Merge request" : "Pull request"}${pr.number === null ? "" : ` #${pr.number}`} "${pr.title}"${pr.branch === null ? "" : ` (branch ${pr.branch})`}`;
    const state =
      pr.mergedAt !== null
        ? `merged ${pr.mergedAt}`
        : pr.closedAt !== null
          ? `closed without merging ${pr.closedAt}`
          : pr.draft === true
            ? "open as a draft"
            : "open, not merged";
    const conflicts = pr.hasConflicts === true ? "; has merge conflicts" : "";
    return `Linked ${name}: ${state}${conflicts}.`;
  });
}

// ---------------------------------------------------------------------------
// plan-detail: vague goals and criteria, decided by code
// ---------------------------------------------------------------------------

const VAGUE: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern:
      /\bhandl(?:e|es|ing)\s+(?:all\s+)?(?:errors?|edge cases|failures)\b/iu,
    why: "names no specific error or behaviour",
  },
  {
    pattern:
      /\bmake\s+(?:it|this|things|everything)\s+(?:fast|faster|better|work|robust|nicer?|cleaner|good)\b/iu,
    why: "states no measurable result",
  },
  {
    pattern:
      /\b(?:works?|working|functions?)\s+(?:properly|correctly|well|as expected|fine)\b/iu,
    why: "says it works without saying how that is checked",
  },
  {
    pattern: /\bas\s+(?:needed|appropriate|necessary|required)\b/iu,
    why: "leaves the scope to judgment",
  },
  { pattern: /\betc\.?(?=\s|$)/iu, why: "leaves the list open" },
  {
    pattern: /\b(?:TBD|TODO|to be decided|figure out)\b/iu,
    why: "is not decided yet",
  },
  {
    pattern: /\b(?:user-friendly|intuitive|seamless|robust|clean|nice)\b/iu,
    why: "uses a quality word with no test",
  },
];

/** Why each part of a task's standard reads as too vague to check, if any. */
export function vagueParts(task: StandardTask): string[] {
  const findings: string[] = [];
  const goal = task.details?.goal?.trim() ?? "";
  const criteria = task.details?.criteria ?? [];
  if (goal === "") findings.push("no goal");
  else if (goal.split(/\s+/u).length < 5)
    findings.push(`goal "${goal}" is too short to judge against`);
  if (criteria.length === 0) findings.push("no acceptance criteria");
  for (const [label, text] of [
    ["goal", goal],
    ...criteria.map((item, index): [string, string] => [
      `criterion ${index + 1}`,
      item,
    ]),
  ]) {
    if (text === undefined || text === "") continue;
    const hit = VAGUE.find((entry) => entry.pattern.test(text));
    if (hit !== undefined) findings.push(`${label} "${text}" ${hit.why}`);
    else if (label !== "goal" && text.split(/\s+/u).length < 3)
      findings.push(`${label} "${text}" is too short to check`);
  }
  return findings;
}

/** plan-detail verdicts for tasks; flagged when a goal or criterion is vague. */
export function planDetailEntries(
  projectKey: ProjectKey,
  sessionId: string | null,
  tasks: readonly StandardTask[],
  source: string,
  config: Judgment["config"] | undefined,
): PendingEntry[] {
  if (config !== undefined && !checkEnabled(config, PLAN_DETAIL_CHECK))
    return [];
  return tasks.map((task) => {
    const findings = vagueParts(task);
    return {
      subject: { projectId: projectKey, taskId: task.key, sessionId },
      entry: deterministicEntry(
        PLAN_DETAIL_CHECK,
        {
          goal: task.details?.goal ?? null,
          criteria: [...(task.details?.criteria ?? [])],
        },
        { block: findings.length > 0, findings },
        {
          source,
          evidence: { kind: "task", ref: `task:${task.key}` },
          outcome: findings.length > 0 ? "flagged" : "passed",
          reason:
            findings.length > 0
              ? `the standard is too vague to check: ${findings.join("; ")}`
              : "the goal and every criterion name something checkable",
        },
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// History reads
// ---------------------------------------------------------------------------

/** Whether a task's latest done check passed and the task is complete. */
export function isVerified(
  access: SqlAccess,
  projectKey: string,
  taskIds: readonly string[],
  status: string,
): boolean {
  if (status !== "complete") return false;
  return latestDoneOutcome(access, projectKey, taskIds) === "verified";
}

/**
 * The latest done run's result for a task: held when a done check failed,
 * verified only when claims-done passed in that run, else unverified; none
 * when no done check ever ran.
 */
export function latestDoneOutcome(
  access: SqlAccess,
  projectKey: string,
  taskIds: readonly string[],
  /** Only entries after this verification seq (the task's verdict floor). */
  after?: number,
): "verified" | "held" | "unverified" | undefined {
  const entries = queryEntries(access, {
    projectId: projectKey,
    taskIds,
    kinds: ["verdict", "unavailable"],
    newest: true,
    limit: 40,
    ...(after === undefined ? {} : { after }),
  });
  const latest = entries.find(
    (entry) =>
      (entry.kind === "verdict" || entry.kind === "unavailable") &&
      DONE_CHECK_IDS.has(entry.body.battery_id),
  );
  if (latest === undefined) return undefined;
  const sameRun = entries.filter(
    (entry) =>
      (entry.kind === "verdict" || entry.kind === "unavailable") &&
      entry.created_at === latest.created_at &&
      DONE_CHECK_IDS.has(entry.body.battery_id),
  );
  return doneRunVerdict(sameRun).verified;
}

/** The claim's report history as `status: text`, oldest first. */
export function previousReports(
  access: SqlAccess,
  projectKey: string,
  workId: string,
): string[] {
  return queryEntries(access, {
    projectId: projectKey,
    workIds: [workId],
    kinds: ["report"],
    newest: true,
    limit: 6,
  })
    .flatMap((entry) =>
      entry.kind === "report"
        ? [`${entry.body.status}: ${entry.body.report}`]
        : [],
    )
    .reverse();
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

export class LedgerVerifier {
  readonly judgment: Judgment;

  constructor(judgment: Judgment) {
    this.judgment = judgment;
  }

  /** Checks for a work_update batch: holds for failed done checks, and every entry. */
  async checkWorkUpdate(
    snapshot: Snapshot,
    contexts: readonly ChangeContext[],
  ): Promise<WorkUpdatePlan> {
    const holds = new Map<WorkId, string>();
    const pending: PendingEntry[] = [];
    await Promise.all(
      contexts.map(async (context) => {
        const result = await this.checkChange(snapshot, context);
        pending.push(...result.pending);
        if (result.hold !== undefined) holds.set(context.work.id, result.hold);
      }),
    );
    return { holds, pending };
  }

  private async checkChange(
    snapshot: Snapshot,
    context: ChangeContext,
  ): Promise<{ pending: PendingEntry[]; hold?: string }> {
    const { change, work, task } = context;
    const subject: Subject = {
      projectId: snapshot.projectKey,
      taskId: task.key,
      workId: work.id,
      sessionId: work.sessionId,
    };
    const standard = taskText(task);
    const report = change.report;
    const status = requestedStatus(change, work);
    const pending: PendingEntry[] = [];
    const add = (entry: NewEntry | undefined) => {
      if (entry !== undefined) pending.push({ subject, entry });
    };
    const base: EntryContext = {
      source: "ledger:work_update",
      evidence: {
        kind: "work_update",
        ref: `work:${work.id}`,
        ...(report === undefined ? {} : { excerpt: report.slice(0, 500) }),
      },
    };

    if (change.action === "handoff") {
      if (report === undefined) {
        add(
          deterministicEntry(
            handoffBattery.id,
            { work: workText(task, task.details, work) },
            { block: true },
            { ...base, outcome: "flagged", reason: "handoff has no note" },
          ),
        );
        return { pending };
      }
      const input = { work: workText(task, task.details, work), note: report };
      const result = await runCheck(this.judgment, handoffBattery, input);
      add(
        entryFor(handoffBattery, input, result, {
          ...base,
          gate: false,
          reason: (decision) =>
            decision.missing.length === 0
              ? "the note carries open work, state, blockers and next step"
              : `the note leaves out: ${decision.missing.join(", ")}`,
        }),
      );
      return { pending };
    }

    if (status === "complete" && work.status !== "complete")
      return this.checkCompletion(context, subject, base);

    const allowed = allowedReasonsText(snapshot.policy, [task.details]);
    if (status === "blocked") {
      const blocker =
        (change.action === undefined || change.action === "progress"
          ? change.blocker
          : undefined) ??
        work.blocker ??
        "";
      const message = [blocker, report]
        .filter((part) => part !== undefined && part.length > 0)
        .join("\n");
      const [reason, deferral, triage] = await Promise.all([
        runCheck(this.judgment, stopReasonBattery, {
          passage: message,
          ...(allowed === undefined ? {} : { allowed }),
        }),
        runCheck(this.judgment, deferralBattery, { standard, message }),
        runCheck(this.judgment, blockerTriageBattery, {
          task: standard,
          blocker: message,
        }),
      ]);
      add(
        entryFor(
          stopReasonBattery,
          { passage: message, ...(allowed === undefined ? {} : { allowed }) },
          reason,
          {
            ...base,
            gate: false,
            reason: (decision) =>
              `reason reads as ${decision.kind} (${decision.confidence.toFixed(2)})`,
          },
        ),
      );
      add(
        entryFor(deferralBattery, { standard, message }, deferral, {
          ...base,
          gate: false,
          reason: (decision) => `defers ${decision.defers.toFixed(2)}`,
        }),
      );
      add(
        entryFor(
          blockerTriageBattery,
          { task: standard, blocker: message },
          triage,
          {
            ...base,
            gate: false,
            reason: (decision) =>
              `needs ${decision.needs}, urgency ${decision.urgency}`,
          },
        ),
      );
      return { pending };
    }

    if (change.action === "release") {
      if (report === undefined) return { pending };
      const [givesUp, reason, deferral] = await Promise.all([
        runCheck(this.judgment, givesUpBattery, { message: report }),
        runCheck(this.judgment, stopReasonBattery, {
          passage: report,
          ...(allowed === undefined ? {} : { allowed }),
        }),
        runCheck(this.judgment, deferralBattery, { standard, message: report }),
      ]);
      add(
        entryFor(givesUpBattery, { message: report }, givesUp, {
          ...base,
          gate: false,
          reason: (decision) => `gives up ${decision.givesUp.toFixed(2)}`,
        }),
      );
      add(
        entryFor(
          stopReasonBattery,
          { passage: report, ...(allowed === undefined ? {} : { allowed }) },
          reason,
          {
            ...base,
            gate: false,
            reason: (decision) =>
              `reason reads as ${decision.kind} (${decision.confidence.toFixed(2)})`,
          },
        ),
      );
      add(
        entryFor(deferralBattery, { standard, message: report }, deferral, {
          ...base,
          gate: false,
          reason: (decision) => `defers ${decision.defers.toFixed(2)}`,
        }),
      );
      return { pending };
    }

    if (report !== undefined && context.previousReports.length >= STALL_AFTER) {
      const updates = [...context.previousReports, `${status}: ${report}`]
        .map((line, index) => `${index + 1}. ${line}`)
        .join("\n");
      const input = { task: standard, updates };
      const result = await runCheck(this.judgment, stalledBattery, input);
      add(
        entryFor(stalledBattery, input, result, {
          ...base,
          gate: false,
          reason: (decision) =>
            `stuck ${decision.stuck.toFixed(2)}, abandoned ${decision.abandoned.toFixed(2)}`,
        }),
      );
    }
    return { pending };
  }

  private async checkCompletion(
    context: ChangeContext,
    subject: Subject,
    base: EntryContext,
  ): Promise<{ pending: PendingEntry[]; hold?: string }> {
    const { change, work, task } = context;
    const pending: PendingEntry[] = [];
    const failures: string[] = [];
    const checks: string[] = [];
    const done: EntryContext = { ...base, reportedStatus: "complete" };
    const progress =
      change.action === undefined || change.action === "progress"
        ? change
        : undefined;
    const checkout =
      progress?.location?.checkout === undefined
        ? work.location.checkout
        : progress.location.checkout;
    const paths = progress?.location?.paths ?? work.location.paths;
    const commitId =
      progress?.commit === undefined ? work.commit : progress.commit;
    const commit: CommitInfo | undefined =
      commitId === null ? undefined : readCommit(checkout, commitId);
    const deterministic: { entry: (applied: string) => NewEntry }[] = [];

    const enabled = (id: string) => checkEnabled(this.judgment.config, id);
    if (
      commit !== undefined &&
      paths.length > 0 &&
      enabled("vibecheck.commit-paths")
    ) {
      const touched = touchesPaths(commit.files, paths);
      const reason = touched
        ? `commit ${commit.commit.slice(0, 12)} changed files under the claimed paths`
        : `commit ${commit.commit.slice(0, 12)} changed no file under the claimed paths (${paths.join(", ")})`;
      if (!touched) {
        failures.push(reason);
        checks.push(reason);
      }
      deterministic.push({
        entry: (applied) =>
          deterministicEntry(
            "vibecheck.commit-paths",
            {
              commit: commit.commit,
              files: [...commit.files],
              paths: [...paths],
            },
            { block: !touched },
            {
              ...done,
              appliedStatus: applied,
              outcome: touched ? "passed" : "failed",
              reason,
            },
          ),
      });
    }

    for (const exception of task.details.exceptions ?? []) {
      if (
        exception.data_only !== true ||
        exception.paths === undefined ||
        !enabled("vibecheck.exception-check")
      )
        continue;
      for (const result of checkDataOnlyPaths(checkout, exception.paths)) {
        const reason = result.dataOnly
          ? `${result.file} holds data only as recorded`
          : `${result.file} is recorded as data only but holds ${result.controlLines} control-flow lines`;
        if (!result.dataOnly) {
          failures.push(reason);
          checks.push(reason);
        }
        deterministic.push({
          entry: (applied) =>
            deterministicEntry(
              "vibecheck.exception-check",
              { ...result },
              { block: !result.dataOnly, controlLines: result.controlLines },
              {
                ...done,
                appliedStatus: applied,
                outcome: result.dataOnly ? "passed" : "failed",
                reason,
              },
            ),
        });
      }
    }

    let childSummary = "";
    if (context.children.length > 0 && enabled("vibecheck.parent-rollup")) {
      const unverified = context.children
        .filter((child) => !child.verified)
        .map((child) => child.key);
      const reason =
        unverified.length === 0
          ? `every child task is verified: ${context.children.map((child) => child.key).join(", ")}`
          : `child tasks not verified: ${unverified.join(", ")}`;
      if (unverified.length > 0) failures.push(reason);
      else
        childSummary = `\n\nChild tasks, each verified complete: ${context.children.map((child) => child.key).join(", ")}.`;
      deterministic.push({
        entry: (applied) =>
          deterministicEntry(
            "vibecheck.parent-rollup",
            { children: context.children.map((child) => ({ ...child })) },
            { block: unverified.length > 0 },
            {
              ...done,
              appliedStatus: applied,
              outcome: unverified.length > 0 ? "failed" : "passed",
              reason,
            },
          ),
      });
    }

    checks.push(...pullRequestLines(context.pullRequests));

    const readings: ((applied: string) => NewEntry | undefined)[] = [];
    const report = change.report;
    if (report !== undefined) {
      const exceptions = exceptionsText([task.details]);
      const input = {
        task: taskText(task),
        ...(exceptions === undefined ? {} : { exceptions }),
        ...(checks.length === 0 ? {} : { checks: checks.join("\n") }),
        report: `${report}${childSummary}`,
      };
      const admitsInput = {
        task: input.task,
        ...(exceptions === undefined ? {} : { exceptions }),
        report: input.report,
      };
      // Both read the same report at once. claims-done lets an openly
      // unfinished report through (right for the Stop hook); marking the task
      // complete is itself the claim, so done-admits-unfinished holds a
      // completion whose report says the work is not done.
      const [result, admits] = await Promise.all([
        runCheck(this.judgment, claimsDoneBattery, input),
        runCheck(this.judgment, doneAdmitsUnfinishedBattery, admitsInput),
      ]);
      if (result.kind === "verdict" && result.run.decision.block)
        failures.push(
          `the report claims done while its contents or checks show criteria unmet (overclaims ${result.run.decision.overclaims.toFixed(2)})`,
        );
      if (admits.kind === "verdict" && admits.run.decision.block)
        failures.push(
          `done-admits-unfinished: the task was marked complete while its report says part of it is not done (admits ${admits.run.decision.admits.toFixed(2)})`,
        );
      readings.push(
        (applied) =>
          entryFor(claimsDoneBattery, input, result, {
            ...done,
            appliedStatus: applied,
            gate: true,
            reason: (decision) =>
              decision.block
                ? `overclaims ${decision.overclaims.toFixed(2)}: the report presents the task as done while it shows work left`
                : `the report supports done (overclaims ${decision.overclaims.toFixed(2)})`,
          }),
        (applied) =>
          entryFor(doneAdmitsUnfinishedBattery, admitsInput, admits, {
            ...done,
            appliedStatus: applied,
            gate: true,
            reason: (decision) =>
              decision.block
                ? `admits ${decision.admits.toFixed(2)}: the task was marked complete while its report says part of it is not done`
                : `the report does not say any part of the task is unfinished (admits ${decision.admits.toFixed(2)})`,
          }),
      );
    }

    if (commit !== undefined) {
      const input = {
        task: taskText(task),
        message: commit.message,
        files: commit.files.join("\n"),
      };
      const result = await runCheck(this.judgment, commitHonestyBattery, input);
      const entry = entryFor(commitHonestyBattery, input, result, {
        ...base,
        gate: false,
        reason: (decision) =>
          `message matches task ${decision.matchesTask.toFixed(2)}, files ${decision.matchesFiles.toFixed(2)}, overstates ${decision.overstates.toFixed(2)}`,
      });
      if (entry !== undefined) pending.push({ subject, entry });
    }

    const hold = failures.length === 0 ? undefined : failures.join("; ");
    const applied = hold === undefined ? "complete" : work.status;
    for (const item of deterministic)
      pending.push({ subject, entry: item.entry(applied) });
    for (const reading of readings) {
      const entry = reading(applied);
      if (entry !== undefined) pending.push({ subject, entry });
    }
    // Without a report claims-done cannot run, so the completion is not
    // verified, whatever the deterministic checks found.
    if (report === undefined)
      pending.push({
        subject,
        entry: deterministicEntry(
          claimsDoneBattery.id,
          null,
          { block: false, review: true },
          {
            ...done,
            appliedStatus: applied,
            outcome: "review",
            reason:
              "reported complete with no report text, so the done claim could not be read",
          },
        ),
      });
    return hold === undefined ? { pending } : { pending, hold };
  }

  /**
   * The done re-check of an issue a person moved to done in Linear:
   * claims-done and done-admits-unfinished against the issue's current
   * standard and its latest report comment, as one done run. It verifies only
   * when both pass; a report that admits work left holds it. With no report
   * the outcome is `review`.
   */
  async recheckDone(
    snapshot: Snapshot,
    task: TaskView,
    report: string | undefined,
  ): Promise<PendingEntry[]> {
    const subject: Subject = {
      projectId: snapshot.projectKey,
      taskId: task.key,
    };
    const context: EntryContext = {
      source: "ledger:reconcile",
      evidence: {
        kind: "linear",
        ref: `issue:${task.identifier}`,
        ...(report === undefined ? {} : { excerpt: report.slice(0, 500) }),
      },
      reportedStatus: "complete",
      appliedStatus: "complete",
    };
    if (report === undefined)
      return [
        {
          subject,
          entry: deterministicEntry(
            claimsDoneBattery.id,
            null,
            { block: false, review: true },
            {
              ...context,
              outcome: "review",
              reason: `${task.identifier} was moved to ${task.stateName} in Linear with no report, so the done claim could not be read`,
            },
          ),
        },
      ];
    const exceptions = exceptionsText([task.details]);
    const input = {
      task: taskText(task),
      ...(exceptions === undefined ? {} : { exceptions }),
      report,
    };
    const admitsInput = {
      task: input.task,
      ...(exceptions === undefined ? {} : { exceptions }),
      report,
    };
    const [result, admits] = await Promise.all([
      runCheck(this.judgment, claimsDoneBattery, input),
      runCheck(this.judgment, doneAdmitsUnfinishedBattery, admitsInput),
    ]);
    const entries = [
      entryFor(claimsDoneBattery, input, result, {
        ...context,
        gate: true,
        reason: (decision) =>
          decision.block
            ? `overclaims ${decision.overclaims.toFixed(2)}: ${task.identifier} is done in Linear while its latest report shows work left`
            : `the latest report supports done (overclaims ${decision.overclaims.toFixed(2)})`,
      }),
      entryFor(doneAdmitsUnfinishedBattery, admitsInput, admits, {
        ...context,
        gate: true,
        reason: (decision) =>
          decision.block
            ? `admits ${decision.admits.toFixed(2)}: ${task.identifier} is done in Linear while its latest report says part of it is not done`
            : `the latest report does not say any part of the task is unfinished (admits ${decision.admits.toFixed(2)})`,
      }),
    ];
    return entries.flatMap((entry) =>
      entry === undefined ? [] : [{ subject, entry }],
    );
  }

  /** claim-overlap between a new claim and the project's other open claims. */
  async afterClaim(
    snapshot: Snapshot,
    claimed: WorkRow,
    task: TaskView,
  ): Promise<PendingEntry[]> {
    const tasks = new Map(
      snapshot.tasks.map((entry) => [entry.issueId, entry]),
    );
    const others = snapshot.openWork
      .filter(
        (work) =>
          work.id !== claimed.id &&
          work.issueId !== claimed.issueId &&
          work.status !== "conflict",
      )
      .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
      .slice(0, OVERLAP_LIMIT);
    if (others.length === 0) return [];
    const claimText = (work: WorkRow, record: TaskView) =>
      `${taskText(record)}${work.location.paths.length === 0 ? "" : `\nPaths: ${work.location.paths.join(", ")}`}`;
    const first = claimText(claimed, task);
    const pending: PendingEntry[] = [];
    await Promise.all(
      others.map(async (other) => {
        const otherTask = tasks.get(other.issueId);
        if (otherTask === undefined) return;
        const input = { first, second: claimText(other, otherTask) };
        const result = await runCheck(
          this.judgment,
          claimOverlapBattery,
          input,
        );
        const entry = entryFor(claimOverlapBattery, input, result, {
          source: "ledger:work_claim",
          evidence: { kind: "claim", ref: `work:${other.id}` },
          gate: false,
          reason: (decision) =>
            `overlaps work ${other.id} on task ${otherTask.key}: duplicate ${decision.duplicate.toFixed(2)}, conflict ${decision.conflict.toFixed(2)}`,
        });
        if (entry !== undefined)
          pending.push({
            subject: {
              projectId: snapshot.projectKey,
              taskId: task.key,
              workId: claimed.id,
              sessionId: claimed.sessionId,
            },
            entry,
          });
      }),
    );
    return pending;
  }

  /**
   * brief-scope, task-duplicate and plan-coverage over a plan change.
   * `otherWork` names the claims other sessions hold, for brief-scope.
   */
  async afterPlanChange(
    projectKey: ProjectKey,
    sessionId: string,
    before: PlanView | undefined,
    after: PlanView,
    source: string,
    otherWork?: string,
  ): Promise<PendingEntry[]> {
    const pending: PendingEntry[] = [];
    const planSubject: Subject = { projectId: projectKey, sessionId };
    const base = (ref: string): EntryContext => ({
      source,
      evidence: { kind: "plan", ref },
    });
    const jobs: Promise<void>[] = [];

    if (before !== undefined && before.revision > 0) {
      const change = describePlanChange(before, after);
      if (change.length > 0) {
        const input = {
          standard: planText(before.tasks, before.policy),
          ...(otherWork === undefined ? {} : { otherWork }),
          brief: `Plan change:\n${change}`,
        };
        jobs.push(
          runCheck(this.judgment, briefScopeBattery, input).then((result) => {
            const entry = entryFor(briefScopeBattery, input, result, {
              ...base(`plan:${before.revision}->${after.revision}`),
              gate: false,
              reason: (decision) =>
                `the change narrows accepted work ${decision.narrows.toFixed(2)}, defers ${decision.defers.toFixed(2)}`,
            });
            if (entry !== undefined)
              pending.push({ subject: planSubject, entry });
          }),
        );
      }
    }

    const previous = new Set(before?.tasks.map((task) => task.key) ?? []);
    const added = after.tasks.filter((task) => !previous.has(task.key));
    const existing = after.tasks.filter(
      (task) => previous.has(task.key) && task.status !== "cancelled",
    );
    const pairs: [StandardTask, StandardTask][] = [];
    for (const task of added)
      for (const other of existing) pairs.push([task, other]);
    for (let index = 0; index < added.length; index++)
      for (let other = 0; other < index; other++) {
        const left = added[index];
        const right = added[other];
        if (left !== undefined && right !== undefined)
          pairs.push([left, right]);
      }
    for (const [task, other] of pairs.slice(0, DUPLICATE_PAIR_LIMIT)) {
      const input = { newTask: taskText(task), existingTask: taskText(other) };
      jobs.push(
        runCheck(this.judgment, taskDuplicateBattery, input).then((result) => {
          const entry = entryFor(taskDuplicateBattery, input, result, {
            ...base(`task:${other.key}`),
            gate: false,
            reason: (decision) =>
              `against task ${other.key}: duplicate ${decision.duplicate.toFixed(2)}, overlap ${decision.overlap.toFixed(2)}`,
          });
          if (entry !== undefined)
            pending.push({
              subject: { ...planSubject, taskId: task.key },
              entry,
            });
        }),
      );
    }

    const goal = after.policy?.goal;
    if (goal !== undefined) {
      const input = { goal, tasks: planText(after.tasks, undefined) };
      jobs.push(
        runCheck(this.judgment, planCoverageBattery, input).then((result) => {
          const entry = entryFor(planCoverageBattery, input, result, {
            ...base(`plan:${after.revision}`),
            gate: false,
            reason: (decision) =>
              `the tasks cover the goal ${decision.covers.toFixed(2)}`,
          });
          if (entry !== undefined)
            pending.push({ subject: planSubject, entry });
        }),
      );
    }
    await Promise.all(jobs);
    return pending;
  }
}

/** Plain-language lines for what a plan revision changed. */
export function describePlanChange(before: PlanView, after: PlanView): string {
  const lines: string[] = [];
  const old = new Map(before.tasks.map((task) => [task.key, task]));
  for (const task of after.tasks) {
    const prior = old.get(task.key);
    const now = task.details;
    const was = prior?.details;
    if (prior === undefined) {
      lines.push(`add task ${taskText(task).replaceAll("\n", " ")}`);
      continue;
    }
    if (prior.status !== "cancelled" && task.status === "cancelled")
      lines.push(`cancel task ${task.key} (${task.title})`);
    if (prior.status === "cancelled" && task.status !== "cancelled")
      lines.push(`restore task ${task.key}`);
    if (prior.title !== task.title)
      lines.push(
        `rename task ${task.key} from '${prior.title}' to '${task.title}'`,
      );
    if (was?.goal !== now?.goal)
      lines.push(
        `change the goal of ${task.key} from '${was?.goal ?? "none"}' to '${now?.goal ?? "none"}'`,
      );
    if (
      JSON.stringify(was?.criteria ?? []) !==
      JSON.stringify(now?.criteria ?? [])
    )
      lines.push(
        `change the criteria of ${task.key} from '${(was?.criteria ?? []).join("; ")}' to '${(now?.criteria ?? []).join("; ")}'`,
      );
    if (
      JSON.stringify(was?.exceptions ?? []) !==
      JSON.stringify(now?.exceptions ?? [])
    )
      lines.push(
        `set the accepted exceptions of ${task.key} to '${(now?.exceptions ?? []).map((item) => item.description).join("; ") || "none"}'`,
      );
    if (JSON.stringify(was?.rules ?? []) !== JSON.stringify(now?.rules ?? []))
      lines.push(
        `set the rules of ${task.key} to '${(now?.rules ?? []).join("; ") || "none"}'`,
      );
  }
  const kept = new Set(after.tasks.map((task) => task.key));
  for (const task of before.tasks)
    if (!kept.has(task.key))
      lines.push(`remove task ${task.key} (${task.title})`);
  if (
    JSON.stringify(before.policy ?? {}) !== JSON.stringify(after.policy ?? {})
  )
    lines.push(
      `change the project policy to ${JSON.stringify(after.policy ?? {})}`,
    );
  return lines.map((line) => `- ${line}`).join("\n");
}
