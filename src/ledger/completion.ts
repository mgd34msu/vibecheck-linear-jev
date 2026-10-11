// Completion plans: closing a claim as a recorded, resumable plan
//.
//
// A work_update that completes work (held or not), releases it or hands it
// off does not write Linear change by change. It first records, in one local
// transaction, the decision the done checks reached (verified, unverified or
// held) with their verification entries, the status this machine will write
// on its claim comment, and the ordered steps. Only then does it write
// Linear, one step at a time:
//
//   move          to the done (or unstarted) state, only from the state the
//                 tool saw; a completion whose move a person overtook is
//                 abandoned, a release goes on and reports the skip
//   add_label     a `vc:*` label (created on first use)
//   remove_label  a `vc:*` label; "not on issue" counts as done
//   agent_label   a handoff target's agent label
//   comment       a report, verdict or successor claim comment, with an id
//                 derived from (session, request, work, purpose)
//   activity      the claim line rewritten to `open · active <time>`
//   close_claim   the claim line rewritten to the plan's closing status
//   drop_claimed  `vc:claimed` removed when no claim comment stays open
//
// and last the local commit: the work rows, the report history and the
// marker that the change of this request landed. Every run first checks in
// Linear that the issue is still in the project and that the work's claim
// comment is still its own and open (or already carries the plan's closing
// status); the move re-reads the issue and the close re-reads the comment.
//
// A failure stops the plan where it is; the record stays pending, and a
// retry with the same request_id, the start of any later tool call or `sync`
// resumes the same plan with the same decision, never judging again. A
// precondition that no longer holds abandons the plan without moving the
// issue: a lost claim releases the work with attention `claim_lost`, an
// issue gone from the project abandons it with `removed`, and a person's
// move leaves the work open with `skipped_move`, and an issue a person took
// out of done after the plan's own move leaves it open with `reopened`.
// Issues a plan reads reach the cache only through the reconciler's
// detection (observeIssue), so no move a person made is hidden from it.

import { z } from "zod";
import { BoardError } from "../errors.js";
import type { Comment, Issue } from "../linear/api.js";
import {
  isKeyRejected,
  isLinearError,
  removeLabelIfPresent,
} from "../linear/errors.js";
import {
  AGENT_LABEL_COLOR,
  VC_LABELS,
  parseClaimComment,
  withClaimActivity,
  withClaimStatus,
  type ClaimStatus,
} from "../linear/states.js";
import type {
  CompletionRow,
  CompletionStep,
  ProjectKey,
  ProjectRow,
  SessionId,
  WorkId,
  WorkRow,
} from "../local/types.js";
import { jsonValueSchema, workChangeSchema } from "../schemas.js";
import { recordReport } from "../verification/reports.js";
import {
  OPEN_WORK,
  vcLabelColor,
  workResult,
  writesLabelsAndStates,
} from "./access.js";
import {
  closeSuccessorClaim,
  lostClaim,
  markClaimLost,
  ownClosingStatuses,
  recordUnfinished,
} from "./claims.js";
import {
  alreadyExists,
  boardErrorFor,
  issueQueued,
  stableId,
  workspaceFor,
  Writer,
  type LedgerDeps,
} from "./context.js";
import { drainOutbox } from "./outbox.js";
import { abandonWork, observeIssue, ownArrival } from "./reconcile.js";

/** Automatic resumes (tool calls, `sync`) of a plan Linear keeps rejecting. */
export const MAX_COMPLETION_ATTEMPTS = 5;

/** The id of the plan a (work, session, request) records. */
export function completionId(
  workId: string,
  sessionId: string,
  requestId: string,
): string {
  return stableId("completion", workId, sessionId, requestId);
}

/** Where a change that landed is remembered, so a retry of its batch skips it. */
export function appliedScope(projectKey: ProjectKey, sessionId: SessionId) {
  return `work_update.applied:${projectKey}:${sessionId}`;
}

export function appliedKey(requestId: string, workId: string): string {
  return `${requestId}\u0000${workId}`;
}

/** The hash a change is remembered by. */
export function changeHash(change: unknown): string {
  return stableId("change", JSON.stringify(change));
}

/** What the applied marker of a change keeps for the retry's result. */
export const appliedSchema = z.object({
  shown: z.array(z.record(z.string(), jsonValueSchema)),
  task: z.object({
    task_id: z.string(),
    identifier: z.string(),
    status: z.string(),
  }),
});
export type AppliedRecord = z.infer<typeof appliedSchema>;

/** The claim status a plan writes on its work's claim comment. */
function closingClaimStatus(row: CompletionRow): ClaimStatus | null {
  if (row.closingStatus === null) return null;
  if (row.kind === "handoff") {
    const successor = row.rows[1];
    return successor === undefined
      ? "released"
      : `handed off to work ${successor.id}`;
  }
  return row.kind === "release" ? "released" : "complete";
}

/** A short name for a step, as results list them. */
export function stepName(step: CompletionStep): string {
  switch (step.kind) {
    case "move":
      return "move";
    case "add_label":
      return `add_label ${step.name}`;
    case "remove_label":
      return `remove_label ${step.name}`;
    case "agent_label":
      return `add_label ${step.name}`;
    case "comment":
      return "comment";
    case "activity":
      return "activity";
    case "close_claim":
      return "close_claim";
    case "drop_claimed":
      return "remove_label vc:claimed";
  }
}

/** What a run of a plan ended with. */
export interface CompletionOutcome {
  readonly row: CompletionRow;
  /** The result the plan recorded once done (also its applied marker). */
  readonly applied?: AppliedRecord;
  /** Why the plan is still pending, or why it was abandoned. */
  readonly error?: BoardError;
}

/** A precondition that no longer holds: the plan is abandoned. */
class Abandon extends Error {
  readonly error: BoardError;
  constructor(error: BoardError) {
    super(error.message);
    this.error = error;
  }
}

/** The result a done plan reports, the same one its applied marker keeps. */
export function appliedOf(row: CompletionRow): AppliedRecord {
  const [work, ...others] = row.rows;
  return {
    shown: [
      ...(work === undefined ? [] : [workResult(work, row.taskKey)]),
      ...others.map((other) => workResult(other, row.taskKey)),
    ],
    task: {
      task_id: row.taskKey,
      identifier: row.identifier,
      status: row.taskStatus,
    },
  };
}

/** Details an error of a plan carries: how far it got. */
function progressDetails(row: CompletionRow) {
  return {
    work_id: row.workId,
    request_id: row.requestId,
    completion: row.state,
    steps_done: row.steps.slice(0, row.done).map(stepName),
    steps_left: [
      ...row.steps.slice(row.done).map(stepName),
      ...(row.state === "pending" ? ["commit"] : []),
    ],
  };
}

/** The error of a run that stopped on a failure: the plan stays pending. */
function pendingError(row: CompletionRow, cause: BoardError): BoardError {
  return new BoardError(
    cause.code,
    `${cause.message} The ${row.kind === "complete" ? "completion" : row.kind} of work ${row.workId} is recorded and pending: ${row.done} of ${row.steps.length} Linear steps are done. It resumes with the same decision on the next tool call, in sync, or when this request is repeated with the same request_id.`,
    progressDetails(row),
  );
}

/** The error an abandoned plan reports. */
function abandonedError(row: CompletionRow, cause: BoardError): BoardError {
  const details = cause.details;
  return new BoardError(cause.code, cause.message, {
    ...(details === undefined || Array.isArray(details) ? {} : details),
    ...progressDetails(row),
  });
}

/** The task status a state type shows, for a release whose move was skipped. */
function statusOfState(issue: Issue): string {
  switch (issue.stateType) {
    case "completed":
      return "complete";
    case "canceled":
      return "cancelled";
    case "started":
      return "in_progress";
    default:
      return "pending";
  }
}

async function readIssue(
  deps: LedgerDeps,
  issueId: string,
): Promise<Issue | null> {
  try {
    return await deps.linear().issue(issueId);
  } catch (error) {
    if (isLinearError(error, "not_found")) return null;
    throw error;
  }
}

/**
 * Runs a plan from its first step that is not done, then commits it
 * locally. Returns the plan as it stands afterwards: done with its result,
 * pending with the failure that stopped it, or abandoned with the reason.
 */
export async function runCompletion(
  deps: LedgerDeps,
  start: CompletionRow,
): Promise<CompletionOutcome> {
  const { store } = deps;
  let row = start;
  const now = () => deps.now().toISOString();
  const save = (patch: Partial<CompletionRow>): CompletionRow => {
    row = { ...row, ...patch, updatedAt: now() };
    store.putCompletion(row);
    return row;
  };
  if (row.state === "done") return { row, applied: appliedOf(row) };
  if (row.state === "abandoned")
    return {
      row,
      error: abandonedError(
        row,
        new BoardError(
          "conflict",
          `The ${row.kind === "complete" ? "completion" : row.kind} of work ${row.workId} was abandoned: ${row.reason ?? "its preconditions no longer held"}.`,
          { reason: "completion_abandoned" },
        ),
      ),
    };
  const project = store.project(row.projectKey);
  const work = store.work(row.workId);
  if (
    project === undefined ||
    work === undefined ||
    !OPEN_WORK.has(work.status)
  ) {
    save({
      state: "abandoned",
      reason: `work ${row.workId} is no longer open on this machine`,
    });
    return {
      row,
      error: abandonedError(
        row,
        new BoardError(
          "conflict",
          `Work ${row.workId} is ${work?.status ?? "gone"}; its pending ${row.kind === "complete" ? "completion" : row.kind} was abandoned.`,
          { reason: "completion_abandoned" },
        ),
      ),
    };
  }
  try {
    await sendQueuedFirst(deps, row);
    await checkPreconditions(deps, project, row, work);
    for (let index = row.done; index < row.steps.length; index++) {
      const step = row.steps[index];
      if (step !== undefined) {
        const patch = await runStep(deps, project, row, work, step);
        if (patch !== undefined) save(patch);
      }
      save({ done: index + 1 });
    }
  } catch (error) {
    if (error instanceof Abandon) {
      // A lost claim or a removed issue already ended the plan (with its
      // review entry and successor close); anything else ends it here.
      const ended = store.completion(row.id)?.state === "abandoned";
      save({ state: "abandoned", reason: error.message });
      if (!ended) {
        recordUnfinished(store, row, error.message);
        closeSuccessorClaim(store, row);
      }
      return { row, error: abandonedError(row, error.error) };
    }
    const failure =
      error instanceof BoardError
        ? error
        : isLinearError(error)
          ? boardErrorFor(error)
          : undefined;
    if (failure === undefined) throw error;
    // Only a rejection counts toward the cap: an unreachable, failing or
    // rate-limited Linear, or a key it refuses outright (401), says nothing
    // about the plan itself. An entity-level 403 counts.
    const rejected = isLinearError(error)
      ? isLinearError(error, "invalid", "not_found", "auth") &&
        !isKeyRejected(error)
      : failure.code !== "unavailable";
    save({
      attempts: rejected ? row.attempts + 1 : row.attempts,
      reason: failure.message,
    });
    return { row, error: pendingError(row, failure) };
  }
  // Linear is written: commit the local state, once.
  const applied = appliedOf(row);
  const access = store.verificationAccess();
  const change = workChangeSchema.parse(row.change);
  store.transaction(() => {
    const latest = store.completion(row.id);
    if (latest === undefined || latest.state !== "pending") return;
    for (const entry of row.rows) store.putWork(entry);
    const [updated] = row.rows;
    if (updated !== undefined)
      recordReport(access, row.taskKey, updated, change, row.sessionId);
    store.putReceipt(
      appliedScope(row.projectKey, row.sessionId),
      appliedKey(row.requestId, row.workId),
      row.changeHash,
      applied,
    );
    save({ state: "done", reason: null });
  });
  return { row, applied };
}

/**
 * Rows this machine queued earlier for the plan's issue go out before any
 * of the plan's writes, in order, so a plan never overtakes them. While they
 * cannot be sent the plan waits (unavailable: it never counts toward the
 * cap); a row Linear keeps rejecting is set aside at the outbox cap.
 */
async function sendQueuedFirst(
  deps: LedgerDeps,
  row: CompletionRow,
): Promise<void> {
  if (!issueQueued(deps.store, row.issueId)) return;
  const drained = await drainOutbox(deps.store, deps.linear(), row.issueId);
  if (!issueQueued(deps.store, row.issueId)) return;
  throw new BoardError(
    "unavailable",
    `older queued Linear writes of ${row.identifier} could not be sent yet (${drained.stopped ?? "Linear rejected one; it is retried on later calls"}); the ${row.kind === "complete" ? "completion" : row.kind} runs after them`,
  );
}

/**
 * What every run checks first in Linear: the issue is still in the project,
 * and the work's claim comment is still its own and open, or already carries
 * the plan's closing status.
 */
async function checkPreconditions(
  deps: LedgerDeps,
  project: ProjectRow,
  row: CompletionRow,
  work: WorkRow,
): Promise<void> {
  const issue = await readIssue(deps, row.issueId);
  await requireInProject(deps, project, row, work, issue);
  await ownClaim(deps, project, row, work);
  if (issue === null) return;
  await requireStillDone(deps, project, row, work, issue);
  // The plan's own move arriving (its answer was lost) is the tool's
  // state; anything else goes through the reconciler's detection first.
  const move = row.steps.findIndex((step) => step.kind === "move");
  const target = row.steps[move];
  if (
    move >= row.done &&
    target?.kind === "move" &&
    issue.stateId === target.stateId
  )
    ownArrival(deps, project, issue);
  else observeIssue(deps, project, issue);
}

/**
 * A completion whose move to done is done must still find the issue done:
 * one a person took out of done since then is not complete. The plan is
 * abandoned with attention `reopened`; the claim stays open (a closing edit
 * already made is taken back, and `vc:claimed` put back), `vc:verified`
 * comes off, and the done run gets its `review` entry.
 */
async function requireStillDone(
  deps: LedgerDeps,
  project: ProjectRow,
  row: CompletionRow,
  work: WorkRow,
  issue: Issue,
): Promise<void> {
  if (row.kind !== "complete" || row.decision === "held") return;
  const move = row.steps.findIndex((step) => step.kind === "move");
  if (move === -1 || move >= row.done || issue.stateType === "completed")
    return;
  const { store } = deps;
  const reason = `${issue.identifier} left done for ${issue.stateName} in Linear after the tool moved it there, before work ${work.id} finished completing it`;
  store.addEvent({
    projectKey: project.key,
    kind: "reopened",
    issueId: issue.id,
    identifier: issue.identifier,
    workId: work.id,
    dedupe: `reopened:${issue.id}:${issue.updatedAt}`,
    body: { reason },
  });
  // The reconciler's detection sees the same move (and adds nothing twice).
  observeIssue(deps, project, issue);
  const writer = new Writer(store, deps.linear(), project.key);
  const workspace = workspaceFor(deps, project.teamId);
  if (writesLabelsAndStates(project)) {
    const verified = await workspace.findLabel("vc:verified");
    if (verified !== undefined) await writer.removeLabel(issue.id, verified);
  }
  const closed = row.steps.findIndex((step) => step.kind === "close_claim");
  if (closed !== -1 && closed < row.done && work.claimCommentId !== null) {
    const commentId = work.claimCommentId;
    const own = (await deps.linear().comments(row.issueId)).find(
      (comment) => comment.id === commentId,
    );
    if (own !== undefined && parseClaimComment(own.body)?.workId === work.id)
      await writer.updateComment(
        own.id,
        withClaimActivity(
          withClaimStatus(own.body, "open"),
          deps.now().toISOString(),
        ),
        row.issueId,
      );
  }
  const dropped = row.steps.findIndex((step) => step.kind === "drop_claimed");
  if (dropped !== -1 && dropped < row.done)
    await writer.addOwnLabel(
      issue.id,
      workspace,
      "vc:claimed",
      vcLabelColor("vc:claimed"),
    );
  throw new Abandon(
    new BoardError(
      "conflict",
      `${issue.identifier} was not completed: ${reason}. Work ${work.id} stays open with its claim; check the issue in Linear, then report again with a new request_id.`,
      {
        reason: "reopened",
        work_id: work.id,
        state: issue.stateName,
      },
    ),
  );
}

/** Abandons the work when its issue left the project or Linear. */
async function requireInProject(
  deps: LedgerDeps,
  project: ProjectRow,
  row: CompletionRow,
  work: WorkRow,
  issue: Issue | null,
): Promise<void> {
  if (issue !== null && issue.projectId === project.linearProjectId) return;
  const why =
    issue === null
      ? "no longer exists in Linear"
      : "left the project in Linear";
  deps.store.uncacheIssue(project.key, row.issueId);
  const writer = new Writer(deps.store, deps.linear(), project.key);
  await abandonWork(deps, project, writer, [work], row.identifier, why);
  throw new Abandon(
    new BoardError(
      "conflict",
      `${row.identifier} ${why}, so it was not moved; work ${work.id} was abandoned and its ${row.kind === "complete" ? "completion" : row.kind} was not finished.`,
      { reason: "task_removed", identifier: row.identifier },
    ),
  );
}

/**
 * The work's claim comment as it stands in Linear, when it is still this
 * work's and open, or already closed with the plan's own status. Anything
 * else (deleted, closed by another machine or a person) loses the claim and
 * abandons the plan.
 */
async function ownClaim(
  deps: LedgerDeps,
  project: ProjectRow,
  row: CompletionRow,
  work: WorkRow,
): Promise<Comment | undefined> {
  if (work.claimCommentId === null) return undefined;
  let comments: readonly Comment[];
  try {
    comments = await deps.linear().comments(row.issueId);
  } catch (error) {
    if (!isLinearError(error, "not_found")) throw error;
    await requireInProject(deps, project, row, work, null);
    return undefined;
  }
  const own = comments.find((comment) => comment.id === work.claimCommentId);
  const reason = lostClaim(
    work,
    comments,
    ownClosingStatuses(deps.store, work.id),
  );
  if (reason === undefined) return own;
  markClaimLost(deps.store, project, work, reason, deps.now().toISOString());
  throw new Abandon(
    new BoardError(
      "conflict",
      `Work ${work.id} lost its claim on ${work.identifier}: ${reason}.`,
      { work_id: work.id, status: "released", reason: "claim_lost" },
    ),
  );
}

/** The `vc:*` label a step names, created on first use. */
async function vcLabelNamed(
  deps: LedgerDeps,
  project: ProjectRow,
  name: string,
) {
  const own = VC_LABELS.find((label) => label.name === name);
  const workspace = workspaceFor(deps, project.teamId);
  if (own === undefined) return workspace.findLabel(name);
  return workspace.ensureLabel(own.name, own.color, {
    description: "Set by vibecheck-linear-jev.",
  });
}

/** Runs one step; returns a change to the plan row when the step makes one. */
async function runStep(
  deps: LedgerDeps,
  project: ProjectRow,
  row: CompletionRow,
  work: WorkRow,
  step: CompletionStep,
): Promise<Partial<CompletionRow> | undefined> {
  const api = deps.linear();
  const { store } = deps;
  const workspace = workspaceFor(deps, project.teamId);
  switch (step.kind) {
    case "move": {
      const fresh = await readIssue(deps, row.issueId);
      await requireInProject(deps, project, row, work, fresh);
      if (fresh === null) return undefined;
      if (fresh.stateId === step.stateId) {
        ownArrival(deps, project, fresh);
        return undefined;
      }
      // The state the tool saw, or one its own queued move brings.
      const expected = [
        ...(step.expectStateId === null ? [] : [step.expectStateId]),
        ...(step.alsoExpect ?? []),
      ];
      if (expected.length > 0 && !expected.includes(fresh.stateId)) {
        observeIssue(deps, project, fresh);
        const reason = `the tool did not move ${fresh.identifier}: it is in ${fresh.stateName}, where it was moved in Linear after the tool last read it`;
        store.addEvent({
          projectKey: project.key,
          kind: "skipped_move",
          issueId: fresh.id,
          identifier: fresh.identifier,
          workId: work.id,
          dedupe: `skipped_move:${fresh.id}:${fresh.updatedAt}`,
          body: { reason },
        });
        if (!step.required) return { taskStatus: statusOfState(fresh) };
        throw new Abandon(
          new BoardError(
            "conflict",
            `${fresh.identifier} was not completed: ${reason}. Work ${work.id} stays open with its claim; check the issue in Linear, then report again with a new request_id.`,
            {
              reason: "skipped_move",
              work_id: work.id,
              state: fresh.stateName,
            },
          ),
        );
      }
      const updated = await api.updateIssue(row.issueId, {
        stateId: step.stateId,
      });
      ownArrival(deps, project, updated);
      return undefined;
    }
    case "add_label": {
      const label = await vcLabelNamed(deps, project, step.name);
      if (label !== undefined) await api.addLabel(row.issueId, label.id);
      return undefined;
    }
    case "remove_label": {
      const label = await workspace.findLabel(step.name);
      if (label !== undefined)
        await removeLabelIfPresent(api, row.issueId, label.id);
      return undefined;
    }
    case "agent_label": {
      const label = await workspace.ensureLabel(step.name, AGENT_LABEL_COLOR, {
        description: "Issues this coding agent claimed through vibecheck.",
      });
      await api.addLabel(row.issueId, label.id);
      return undefined;
    }
    case "comment": {
      try {
        await api.createComment({
          id: step.id,
          issueId: row.issueId,
          body: step.body,
        });
      } catch (error) {
        if (!alreadyExists(error)) throw error;
      }
      return undefined;
    }
    case "activity": {
      const own = await ownClaim(deps, project, row, work);
      if (own !== undefined)
        await api.updateComment(own.id, withClaimActivity(own.body, step.at));
      return undefined;
    }
    case "close_claim": {
      const status = closingClaimStatus(row);
      const own = await ownClaim(deps, project, row, work);
      if (
        own === undefined ||
        status === null ||
        parseClaimComment(own.body)?.status === status
      )
        return undefined;
      try {
        await api.updateComment(own.id, withClaimStatus(own.body, status));
      } catch (error) {
        if (!isLinearError(error, "not_found")) throw error;
        // Deleted between the read and the edit: re-checked as lost.
        await ownClaim(deps, project, row, work);
      }
      return undefined;
    }
    case "drop_claimed": {
      const others = store
        .workForIssue(project.key, row.issueId)
        .filter((entry) => entry.id !== work.id && OPEN_WORK.has(entry.status));
      if (others.length > 0) return undefined;
      const comments = await api.comments(row.issueId);
      if (
        comments.some((comment) => {
          const claim = parseClaimComment(comment.body);
          return claim?.status === "open" && claim.workId !== work.id;
        })
      )
        return undefined;
      const label = await workspace.findLabel("vc:claimed");
      if (label !== undefined)
        await removeLabelIfPresent(api, row.issueId, label.id);
      return undefined;
    }
  }
}

/**
 * Resumes pending plans: of one project, or of every project (`sync`).
 * Called at the start of every tool call. A plan Linear rejected
 * (invalid, not found, refused key) MAX_COMPLETION_ATTEMPTS times waits for
 * its request to be repeated, shown as attention `completion_waiting`; an
 * unreachable, failing or rate-limited Linear never counts toward that cap
 * and stops the resumes until the next call.
 */
export async function resumeCompletions(
  deps: LedgerDeps,
  projectKey?: ProjectKey,
): Promise<{ readonly resumed: number; readonly pending: number }> {
  let resumed = 0;
  for (const row of deps.store.pendingCompletions(projectKey)) {
    if (row.attempts >= MAX_COMPLETION_ATTEMPTS) continue;
    // A plan waits behind queued rows of its issue the drain could not send.
    if (issueQueued(deps.store, row.issueId)) continue;
    const outcome = await runCompletion(deps, row);
    if (outcome.row.state !== "pending") resumed += 1;
    else if (outcome.error?.code === "unavailable") break;
  }
  return {
    resumed,
    pending: deps.store.pendingCompletions(projectKey).length,
  };
}

/** The pending plan of a work recorded by another request, if any. */
export function otherPendingCompletion(
  deps: LedgerDeps,
  workId: WorkId,
  id: string,
): CompletionRow | undefined {
  return deps.store
    .completionsForWork(workId)
    .find((row) => row.state === "pending" && row.id !== id);
}
