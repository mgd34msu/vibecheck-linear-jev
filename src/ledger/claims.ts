// Claim comments in Linear and closing a claim.
//
// A claim is open while its claim comment says `open`. Closing one edits the
// comment's claim line (the rest of the comment, a person's text included,
// stays as it is) and, when no other claim on the issue is open (on this
// machine or in Linear), removes `vc:claimed`. Both writes go through the
// call's Writer, so an unreachable Linear queues them; a comment or issue a
// person deleted counts as closed. A claim another machine or a person
// closed (or deleted) is lost: the work is released here with attention
// `claim_lost`, and any completion plan it had pending is abandoned.

import type { Comment, LinearApi } from "../linear/api.js";
import { isLinearError } from "../linear/errors.js";
import {
  commentAuthor,
  isOpenClaim,
  parseClaimComment,
  renderClaimComment,
  withClaimStatus,
  type ClaimStatus,
  type CommentAuthor,
} from "../linear/states.js";
import type {
  CompletionRow,
  LocalStore,
  ProjectRow,
  WorkRow,
} from "../local/types.js";
import { deterministicEntry } from "../jev/entries.js";
import { recordEntries } from "../verification/ledger.js";
import { OPEN_WORK, writesLabelsAndStates } from "./access.js";
import { authorOf, workspaceFor, type LedgerDeps, Writer } from "./context.js";

/** An open claim comment and the work id it names. */
export interface OpenClaim {
  readonly comment: Comment;
  readonly workId: string;
}

/** Open claim comments among `comments`, earliest first (server createdAt, then id). */
export function openClaims(comments: readonly Comment[]): OpenClaim[] {
  return comments
    .filter((comment) => isOpenClaim(comment.body))
    .flatMap((comment) => {
      const parsed = parseClaimComment(comment.body);
      return parsed === null ? [] : [{ comment, workId: parsed.workId }];
    })
    .sort(
      (left, right) =>
        left.comment.createdAt.localeCompare(right.comment.createdAt) ||
        left.comment.id.localeCompare(right.comment.id),
    );
}

/** The issue's open claim comments, read from Linear. */
export async function claimComments(
  api: LinearApi,
  issueId: string,
): Promise<OpenClaim[]> {
  return openClaims(await api.comments(issueId));
}

/** The author line a work's claim comment carries. */
export function claimAuthor(deps: LedgerDeps, work: WorkRow): CommentAuthor {
  const session = deps.store.session(work.sessionId);
  return session === undefined
    ? { vendor: "vibecheck", model: "reconciler", sessionId: work.sessionId }
    : authorOf(session);
}

/**
 * Closes a work's claim in Linear: its claim comment gets `status`, and
 * `vc:claimed` comes off the issue when no other claim is open. The local
 * row is the caller's to write.
 */
export async function closeClaim(
  deps: LedgerDeps,
  project: ProjectRow,
  writer: Writer,
  work: WorkRow,
  status: ClaimStatus,
): Promise<void> {
  if (work.claimCommentId !== null) {
    const commentId = work.claimCommentId;
    let current: Comment | undefined;
    if (!writer.offline)
      try {
        current = (await deps.linear().comments(work.issueId)).find(
          (comment) => comment.id === commentId,
        );
      } catch (error) {
        if (
          !isLinearError(
            error,
            "not_found",
            "network",
            "server",
            "rate_limited",
          )
        )
          throw error;
      }
    await writer.updateComment(
      commentId,
      current !== undefined &&
        parseClaimComment(current.body)?.workId === work.id
        ? withClaimStatus(current.body, status)
        : renderClaimComment(claimAuthor(deps, work), work.id, status),
      work.issueId,
    );
  }
  await dropClaimLabel(deps, project, writer, work.issueId, [work.id]);
}

/**
 * A completion the done checks passed that was abandoned before the issue
 * reached done: its done run is followed by a `review` entry, so the task's
 * latest done run reads unverified, not verified, while it stays open. A
 * held completion, a release and a handoff record nothing.
 */
export function recordUnfinished(
  store: LocalStore,
  plan: CompletionRow,
  reason: string,
): void {
  if (plan.kind !== "complete" || plan.decision === "held") return;
  const access = store.verificationAccess();
  const work = store.work(plan.workId);
  store.transaction(() =>
    recordEntries(access, [
      {
        subject: {
          projectId: plan.projectKey,
          taskId: plan.taskKey,
          workId: plan.workId,
          sessionId: plan.sessionId,
        },
        entry: deterministicEntry(
          "vibecheck.claims-done",
          null,
          { block: false, review: true },
          {
            source: "ledger:completion",
            evidence: { kind: "linear", ref: `issue:${plan.identifier}` },
            reportedStatus: "complete",
            appliedStatus: work?.status ?? "in_progress",
            outcome: "review",
            reason: `the completion of work ${plan.workId} was abandoned before ${plan.identifier} reached done (${reason}), so it is not verified`,
          },
        ),
      },
    ]),
  );
}

/**
 * A handoff plan abandoned after its successor's claim comment may have
 * landed: that comment is rewritten as `abandoned` (queued; the drain sends
 * it only while the comment still reads open and names the successor, and
 * rewrites only its claim line), so it never holds the issue for work that
 * does not exist. A queued `vc:claimed` removal enqueued after it then
 * follows the usual open-claim rule.
 */
export function closeSuccessorClaim(store: LocalStore, plan: CompletionRow) {
  if (plan.kind !== "handoff") return;
  const successor = plan.rows[1];
  const commentId = successor?.claimCommentId ?? null;
  if (successor === undefined || commentId === null) return;
  const step = plan.steps.find(
    (entry) => entry.kind === "comment" && entry.id === commentId,
  );
  if (step === undefined || step.kind !== "comment") return;
  store.enqueue({
    projectKey: plan.projectKey,
    kind: "update_comment",
    payload: {
      id: commentId,
      body: withClaimStatus(step.body, "abandoned"),
      issueId: plan.issueId,
      onlyIfOpenClaim: true,
      workId: successor.id,
      closeAs: "abandoned",
    },
  });
}

/**
 * Abandons every pending completion plan of a work: the work was released
 * or abandoned some other way, so its plan must never run again. A
 * completion the checks passed gets its `review` entry (it never reached
 * done), and a handoff's successor claim comment is closed as `abandoned`.
 */
export function endCompletions(
  store: LocalStore,
  workId: WorkRow["id"],
  reason: string,
  now: string,
): void {
  for (const plan of store.completionsForWork(workId))
    if (plan.state === "pending") {
      store.putCompletion({
        ...plan,
        state: "abandoned",
        reason,
        updatedAt: now,
      });
      recordUnfinished(store, plan, reason);
      closeSuccessorClaim(store, plan);
    }
}

/**
 * Records that another machine or a person closed (or deleted) a work's
 * claim comment: the work becomes `released`, attention `claim_lost` gives
 * `reason`, and a completion plan it had pending is abandoned. Every later
 * work_update on it is refused with `claim_lost`. In projects where the tool
 * writes labels, a `vc:claimed` removal is queued; the drain sends it only
 * while no claim comment on the issue reads open, so a new holder keeps it.
 */
export function markClaimLost(
  store: LocalStore,
  project: ProjectRow,
  work: WorkRow,
  reason: string,
  now: string,
): void {
  const projectKey = project.key;
  store.transaction(() => {
    const current = store.work(work.id) ?? work;
    store.putWork({
      ...current,
      status: "released",
      revision: current.revision + 1,
      updatedAt: now,
    });
    store.addEvent({
      projectKey,
      kind: "claim_lost",
      issueId: work.issueId,
      identifier: work.identifier,
      workId: work.id,
      dedupe: `claim_lost:${work.id}`,
      body: { reason },
    });
    endCompletions(store, work.id, `the claim was lost: ${reason}`, now);
    const others = store
      .workForIssue(projectKey, work.issueId)
      .filter((entry) => entry.id !== work.id && OPEN_WORK.has(entry.status));
    if (writesLabelsAndStates(project) && others.length === 0)
      store.enqueue({
        projectKey,
        kind: "remove_label",
        payload: { issueId: work.issueId, labelName: "vc:claimed" },
      });
  });
}

/**
 * Why a work's claim is lost, given the issue's comments, or undefined while
 * it stands. Its claim comment must still be this work's and read `open`, or
 * carry a status this machine recorded it is writing itself (`ownStatuses`:
 * the closing status of a pending completion plan). A claim comment that was
 * deleted, or rewritten so it no longer names this work, is lost too.
 */
export function lostClaim(
  work: WorkRow,
  comments: readonly Comment[],
  ownStatuses: ReadonlySet<string> = new Set(),
): string | undefined {
  if (work.claimCommentId === null) return undefined;
  const own = comments.find((comment) => comment.id === work.claimCommentId);
  const parsed = own === undefined ? null : parseClaimComment(own.body);
  if (
    parsed !== null &&
    parsed.workId === work.id &&
    (parsed.status === "open" || ownStatuses.has(parsed.status))
  )
    return undefined;
  const holder = comments
    .filter((comment) => comment.id !== work.claimCommentId)
    .map((comment) => ({ comment, claim: parseClaimComment(comment.body) }))
    .find(({ claim }) => claim?.status === "open");
  const holderAuthor =
    holder === undefined ? null : commentAuthor(holder.comment.body);
  const by =
    holder?.claim == null
      ? "no other claim is open on it"
      : `work ${holder.claim.workId}${holderAuthor === null ? "" : ` of ${holderAuthor.vendor} (session ${holderAuthor.sessionId})`} holds it now`;
  const what =
    own === undefined
      ? "was deleted in Linear, which counts as closed by someone else"
      : parsed === null || parsed.workId !== work.id
        ? "was rewritten in Linear and no longer names this work"
        : `was closed in Linear as "${parsed.status}" by another machine or a person`;
  return `the claim comment of work ${work.id} on ${work.identifier} ${what}, and ${by}; work ${work.id} was released here: stop working on it and claim the task again only if it is free`;
}

/** The closing statuses this machine recorded for a work's pending completion plans. */
export function ownClosingStatuses(
  store: LocalStore,
  workId: WorkRow["id"],
): Set<string> {
  return new Set(
    store
      .completionsForWork(workId)
      .flatMap((plan) =>
        plan.state === "pending" && plan.closingStatus !== null
          ? [plan.closingStatus]
          : [],
      ),
  );
}

/**
 * Removes `vc:claimed` from an issue unless a claim other than `closing` is
 * still open, locally or in Linear. When Linear cannot be read the removal is
 * queued with the rest of the call's writes.
 */
export async function dropClaimLabel(
  deps: LedgerDeps,
  project: ProjectRow,
  writer: Writer,
  issueId: string,
  closing: readonly string[],
): Promise<void> {
  if (!writesLabelsAndStates(project)) return;
  const others = deps.store
    .workForIssue(project.key, issueId)
    .filter(
      (entry) => !closing.includes(entry.id) && OPEN_WORK.has(entry.status),
    );
  if (others.length > 0) return;
  if (!writer.offline) {
    try {
      const open = await claimComments(deps.linear(), issueId);
      if (open.some((entry) => !closing.includes(entry.workId))) return;
    } catch (error) {
      if (isLinearError(error, "not_found")) return;
      if (!isLinearError(error, "network", "server", "rate_limited"))
        throw error;
    }
  }
  const label = await workspaceFor(deps, project.teamId).findLabel(
    "vc:claimed",
  );
  if (label !== undefined) await writer.removeLabel(issueId, label);
}
