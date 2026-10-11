// work_claim and work_update: the claim protocol and work reports on Linear
//.
//
// A claim is decided in Linear: the issue carries `vc:claimed` and an open
// claim comment, and when two agents claim at once the earliest open claim
// comment (server createdAt, then comment id) wins. The local work row holds
// the claim's facts (paths, commits, blocker). Agents on one machine
// serialize through the local store before they reach Linear; the row is
// written before the claim comment, so a crash in between leaves a pending
// row the reconciler settles.
//
// An open claim comment whose work is finished on this machine, or that this
// machine wrote for work it never recorded, no longer blocks a claim: it is
// closed as `abandoned`. One whose work this machine does not know blocks
// until it has shown no tool activity for STALE_CLAIM_MS; then `force_release`
// (or naming it in `replace_work_id`) closes it.
//
// A done report runs the done checks once. Completion, held or not, release
// and handoff run as completion plans (src/ledger/completion.ts): the
// decision, its verification entries and the ordered Linear steps are
// recorded locally before the first Linear write, and a failure leaves the
// plan pending to resume with the same decision (no re-judging). A pass moves
// the issue to the team's done state with `vc:verified` (only when the done
// checks verify it); a held completion keeps it in progress with `vc:held`
// and a verdict comment, and the work stays open. Any other change writes
// Linear first and commits the local row last, so a change that fails
// leaves the row as it was and can be retried; writes that cannot reach
// Linear go to the outbox and the result says how many wait. Every change
// records activity on the claim comment as it stands in Linear: one that was
// deleted or closed by someone else loses the claim.

import { BoardError, type BoardErrorDetails } from "../errors.js";
import type { Comment, Issue } from "../linear/api.js";
import { isLinearError } from "../linear/errors.js";
import {
  AGENT_LABEL_COLOR,
  agentLabelName,
  commentAuthor,
  isReportComment,
  parseClaimComment,
  renderClaimComment,
  renderReportComment,
  renderVerdictComment,
  withClaimStatus,
  type CommentAuthor,
  type ReportKind,
  type VcLabelName,
} from "../linear/states.js";
import type {
  CompletionRow,
  CompletionStep,
  ProjectRow,
  SessionRow,
  WorkId,
  WorkRow,
  WorkStatus,
} from "../local/types.js";
import type { WorkChange, WorkClaim, WorkUpdate } from "../schemas.js";
import {
  describeEntry,
  doneItemsVerified,
  isVerified,
  previousReports,
  recordEntries,
  type ChangeContext,
  type PendingEntry,
  type VerificationItem,
  type WorkUpdatePlan,
} from "../verification/ledger.js";
import { recordReport } from "../verification/reports.js";
import {
  OPEN_WORK,
  currentRevision,
  issueResult,
  locationRecord,
  mergeLocation,
  newWorkId,
  requireAdopted,
  requireLinked,
  requireProject,
  requireSession,
  sessionIdOf,
  vcLabelColor,
  workIdOf,
  workResult,
  writesLabelsAndStates,
  projectKeyOf,
} from "./access.js";
import {
  claimComments,
  dropClaimLabel,
  lostClaim,
  markClaimLost,
  openClaims,
  ownClosingStatuses,
  type OpenClaim,
} from "./claims.js";
import {
  appliedKey,
  appliedOf,
  appliedSchema,
  appliedScope,
  changeHash,
  completionId,
  otherPendingCompletion,
  runCompletion,
  type AppliedRecord,
} from "./completion.js";
import {
  authorOf,
  boardErrorFor,
  freshId,
  stableId,
  workspaceFor,
  Writer,
  type LedgerDeps,
  type MoveExpectation,
  type Workspace,
} from "./context.js";
import { pendingAttention } from "./attention.js";
import { abandonWork, reconcile } from "./reconcile.js";
import {
  buildSnapshot,
  childrenOf,
  keysOf,
  taskView,
  type Snapshot,
  type TaskView,
} from "./snapshot.js";
import { setVerdictFloor } from "./verdicts.js";

/**
 * How long an open claim comment of work this machine does not know must
 * show no tool activity before `force_release` may close it.
 */
export const STALE_CLAIM_MS = 24 * 60 * 60 * 1000;

/**
 * Refreshes this machine's plan map from Linear. plan.ts registers it when it
 * loads (it imports this module, so this module cannot import it).
 */
let planMapRefresher: (
  deps: LedgerDeps,
  project: ProjectRow,
) => Promise<ProjectRow> = async (_deps, project) => project;

export function setPlanMapRefresher(refresh: typeof planMapRefresher): void {
  planMapRefresher = refresh;
}

/** The issue a task id names: a plan key of the current revision, or an identifier or URL. */
export async function resolveIssue(
  deps: LedgerDeps,
  project: ProjectRow,
  ref: string,
): Promise<Issue> {
  const api = deps.linear();
  const find = async (row: ProjectRow): Promise<Issue | null> => {
    const mapped = currentRevision(deps.store, row)?.tasks.find(
      (task) => task.key === ref,
    );
    const lookup =
      mapped?.issueId ?? /\/issue\/([A-Za-z0-9]+-\d+)/u.exec(ref)?.[1] ?? ref;
    const found = await api.issue(lookup);
    return found === null || found.projectId !== row.linearProjectId
      ? null
      : found;
  };
  let issue = await find(project);
  if (issue === null && project.planDocumentId !== null) {
    // Another machine may have added the task since this one last read the
    // plan map: refresh it from Linear once before giving up.
    issue = await find(await planMapRefresher(deps, project));
  }
  if (issue === null)
    throw new BoardError(
      "not_found",
      `No task ${ref} in project ${project.key}: use a plan key or an issue identifier of the project.`,
      { task_id: ref },
    );
  return issue;
}

function keyFor(project: ProjectRow, deps: LedgerDeps, issue: Issue): string {
  // The stored row: resolving the task may have refreshed the plan map.
  const current = deps.store.project(project.key) ?? project;
  return (
    keysOf(currentRevision(deps.store, current)).get(issue.id) ??
    issue.identifier
  );
}

async function snapshotFor(
  deps: LedgerDeps,
  project: ProjectRow,
  workspace: Workspace,
): Promise<Snapshot> {
  const { resolved } = await workspace.states();
  const issues = deps.store.cachedIssues(project.key);
  return buildSnapshot({
    project,
    issues,
    journal: currentRevision(deps.store, project),
    labelNames: await workspace.labelNames(
      issues.flatMap((issue) => issue.labelIds),
    ),
    reviewStateId: resolved.review?.id ?? null,
    openWork: deps.store.openWork(project.key),
  });
}

/** Records the verification entries and returns their summaries, in order. */
function record(
  deps: LedgerDeps,
  pending: readonly PendingEntry[],
): VerificationItem[] {
  if (pending.length === 0) return [];
  const access = deps.store.verificationAccess();
  return deps.store.transaction(() => recordEntries(access, pending));
}

/** What a state move did: sent, queued for the drain, or skipped. */
type MoveOutcome = "moved" | "queued" | "skipped";

/**
 * Moves an issue's state and caches the result. Every immediate move first
 * re-reads the issue: one that left the project (or Linear) abandons its
 * open work here and ends the call with a conflict; one whose state is not
 * the state the tool expected (a person moved it since the tool read it) is
 * not moved and gets attention `skipped_move`. When Linear is unreachable
 * the move is queued carrying the state the tool expected, so the drain
 * skips it if a person moved the issue first, and an expected-move marker
 * tells the reconciler that the state, once it lands, is the tool's own.
 */
async function moveIssue(
  deps: LedgerDeps,
  project: ProjectRow,
  writer: Writer,
  target: { readonly id: string; readonly identifier: string },
  stateId: string,
  extra: { readonly assigneeId?: string } = {},
  expect: MoveExpectation = {},
): Promise<MoveOutcome> {
  const { store } = deps;
  if (!writer.offline) {
    let fresh: Issue | null | undefined;
    try {
      fresh = await deps.linear().issue(target.id);
    } catch (error) {
      if (isLinearError(error, "not_found")) fresh = null;
      else if (!isLinearError(error, "network", "server", "rate_limited"))
        throw error;
      // Unreachable: the move below queues with its expectations.
    }
    if (
      fresh === null ||
      (fresh !== undefined && fresh.projectId !== project.linearProjectId)
    ) {
      const works = store
        .workForIssue(project.key, target.id)
        .filter((work) => OPEN_WORK.has(work.status));
      const identifier = fresh?.identifier ?? target.identifier;
      const why =
        fresh === null
          ? "no longer exists in Linear"
          : "left the project in Linear";
      store.uncacheIssue(project.key, target.id);
      await abandonWork(deps, project, writer, works, identifier, why);
      throw new BoardError(
        "conflict",
        `${identifier} ${why}, so it was not moved; ${works.length === 0 ? "no work of this machine was open on it" : `work ${works.map((work) => work.id).join(", ")} was abandoned`} and nothing else of this change was written.`,
        {
          reason: "task_removed",
          identifier,
          work_ids: works.map((work) => work.id),
        },
      );
    }
    if (fresh !== undefined) {
      if (fresh.stateId === stateId && extra.assigneeId === undefined) {
        store.cacheIssues(project.key, [fresh]);
        return "moved";
      }
      if (expect.stateId !== undefined && fresh.stateId !== expect.stateId) {
        store.cacheIssues(project.key, [fresh]);
        store.addEvent({
          projectKey: project.key,
          kind: "skipped_move",
          issueId: fresh.id,
          identifier: fresh.identifier,
          workId: null,
          dedupe: `skipped_move:${fresh.id}:${fresh.updatedAt}`,
          body: {
            reason: `the tool did not move ${fresh.identifier}: it is in ${fresh.stateName}, where it was moved in Linear after the tool last read it`,
          },
        });
        return "skipped";
      }
    }
  }
  const updated = await writer.updateIssue(
    target.id,
    { stateId, ...extra },
    { ...expect, projectId: project.linearProjectId },
  );
  if (updated !== undefined) {
    store.cacheIssues(project.key, [updated]);
    return "moved";
  }
  store.addEvent({
    projectKey: project.key,
    kind: "expected_move",
    issueId: target.id,
    identifier: target.identifier,
    workId: null,
    dedupe: `expected_move:${target.id}:${stateId}:${deps.now().toISOString()}`,
    body: { stateId },
  });
  return "queued";
}

/**
 * The newest tool activity on an issue for a claim: its comment, the
 * activity time its claim line records, or a later report.
 */
function lastActivity(entry: OpenClaim, comments: readonly Comment[]): string {
  const recorded = parseClaimComment(entry.comment.body)?.activeAt;
  const start = [
    entry.comment.createdAt,
    entry.comment.updatedAt,
    ...(recorded === undefined || Number.isNaN(Date.parse(recorded))
      ? []
      : [new Date(recorded).toISOString()]),
  ].reduce((latest, value) => (value > latest ? value : latest));
  return comments
    .filter(
      (comment) =>
        isReportComment(comment.body) &&
        comment.createdAt >= entry.comment.createdAt,
    )
    .map((comment) => comment.createdAt)
    .reduce((latest, value) => (value > latest ? value : latest), start);
}

/** Records `related` relations for flagged claim overlaps (not in as-is projects). */
async function relateOverlaps(
  deps: LedgerDeps,
  project: ProjectRow,
  writer: Writer,
  issueId: string,
  pending: readonly PendingEntry[],
  items: readonly VerificationItem[],
): Promise<void> {
  if (project.adoption === "as_is") return;
  const others = new Set<string>();
  pending.forEach(({ entry }, index) => {
    if (
      entry.kind !== "verdict" ||
      entry.body.battery_id !== "vibecheck.claim-overlap" ||
      items[index]?.outcome !== "flagged"
    )
      return;
    const workId = entry.body.evidence?.ref.replace(/^work:/u, "");
    const other =
      workId === undefined ? undefined : deps.store.work(workIdOf(workId));
    if (other !== undefined && other.issueId !== issueId)
      others.add(other.issueId);
  });
  if (others.size === 0) return;
  let existing: readonly { issueId: string; relatedIssueId: string }[] = [];
  if (!writer.offline)
    try {
      existing = await deps.linear().relations(issueId);
    } catch (error) {
      if (!isLinearError(error, "network", "server", "rate_limited"))
        throw error;
    }
  for (const other of others) {
    if (
      existing.some(
        (relation) =>
          (relation.issueId === issueId && relation.relatedIssueId === other) ||
          (relation.issueId === other && relation.relatedIssueId === issueId),
      )
    )
      continue;
    const [first, second] = [issueId, other].sort();
    await writer.relation({
      id: stableId(first ?? issueId, "related", second ?? other),
      type: "related",
      issueId,
      relatedIssueId: other,
    });
  }
}

export async function workClaim(deps: LedgerDeps, request: WorkClaim) {
  const { store } = deps;
  const project = requireProject(store, projectKeyOf(request.project_id));
  requireAdopted(project);
  requireLinked(project);
  const session = requireSession(
    store,
    project,
    sessionIdOf(request.session_id),
  );
  const api = deps.linear();
  const workspace = workspaceFor(deps, project.teamId);
  const issue = await resolveIssue(deps, project, request.task_id);
  if (issue.stateType === "completed" || issue.stateType === "canceled")
    throw new BoardError(
      "conflict",
      `${issue.identifier} is ${issue.stateName}; a finished task cannot be claimed.`,
    );
  const key = keyFor(project, deps, issue);
  const now = deps.now().toISOString();
  const workId = newWorkId();
  const replaced =
    request.replace_work_id == null ? null : workIdOf(request.replace_work_id);

  // 1. Same machine: one open claim per issue, decided in one transaction.
  //    The row is written before the claim comment: with no comment id yet
  //    it is pending, and the reconciler settles it after a crash.
  const row: WorkRow = {
    id: workId,
    projectKey: project.key,
    issueId: issue.id,
    identifier: issue.identifier,
    sessionId: session.id,
    status: "in_progress",
    blocker: null,
    location: locationRecord(request.location),
    commit: null,
    integrationCommit: null,
    integrationRequired: false,
    claimCommentId: null,
    predecessorWorkId: replaced,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  let replacedOpen: WorkRow | undefined;
  store.transaction(() => {
    const open = store
      .workForIssue(project.key, issue.id)
      .filter((work) => OPEN_WORK.has(work.status));
    replacedOpen =
      replaced === null ? undefined : open.find((work) => work.id === replaced);
    // A replace_work_id that is not open here may name a claim comment with
    // no live work behind it; Linear is checked below.
    if (replaced !== null && replacedOpen === undefined) {
      const local = store.work(replaced);
      if (local !== undefined && OPEN_WORK.has(local.status))
        throw new BoardError(
          "conflict",
          `Work ${replaced} is not an open claim on ${issue.identifier}.`,
        );
    }
    const other = open.find((work) => work.id !== replaced);
    if (other !== undefined)
      throw new BoardError(
        "conflict",
        `${issue.identifier} is already claimed by work ${other.id}.`,
        { work_id: other.id, session_id: other.sessionId },
      );
    if (replacedOpen !== undefined)
      store.putWork({
        ...replacedOpen,
        status: "abandoned",
        revision: replacedOpen.revision + 1,
        updatedAt: now,
      });
    store.putWork(row);
  });
  const fail = (status: WorkStatus) =>
    store.putWork({ ...row, status, revision: 2, updatedAt: now });
  const writer = new Writer(store, api, project.key);
  let posted: Comment | undefined;

  try {
    // 2. Linear: an open claim comment of other live work means it is taken.
    //    replace_work_id naming work this machine does not know follows the
    //    force_release rule: allowed only once that claim is stale.
    const comments = await api.comments(issue.id);
    const before = openClaims(comments);
    const closing: OpenClaim[] = [];
    const releasing: OpenClaim[] = [];
    for (const entry of before) {
      if (entry.workId === workId) continue;
      if (replacedOpen !== undefined && entry.workId === replaced) {
        releasing.push(entry);
        continue;
      }
      const local = store.work(workIdOf(entry.workId));
      if (local !== undefined && OPEN_WORK.has(local.status)) {
        fail("conflict");
        throw new BoardError(
          "conflict",
          `${issue.identifier} is already claimed by work ${entry.workId}.`,
          { work_id: entry.workId, session_id: local.sessionId },
        );
      }
      // Finished here: the comment outlived its work; any session closes it.
      if (local !== undefined) {
        closing.push(entry);
        continue;
      }
      // Written by a session of this machine for work it never recorded.
      const author = commentAuthor(entry.comment.body);
      const ours =
        author !== null &&
        store.session(sessionIdOf(author.sessionId))?.projectKey ===
          project.key;
      if (ours) {
        closing.push(entry);
        continue;
      }
      const last = lastActivity(entry, comments);
      const stale = Date.parse(now) - Date.parse(last) >= STALE_CLAIM_MS;
      const named = entry.workId === replaced;
      if (stale && named) {
        releasing.push(entry);
        continue;
      }
      if (stale && request.force_release === true) {
        closing.push(entry);
        continue;
      }
      fail("conflict");
      const holder =
        author === null
          ? `work ${entry.workId}`
          : `work ${entry.workId} of ${author.vendor} (session ${author.sessionId})`;
      throw new BoardError(
        "conflict",
        stale
          ? `${issue.identifier} has an open claim comment of ${holder}, which this machine does not know and which shows no activity since ${last}. If that work is dead, repeat work_claim with force_release: true (and a new request_id) to close its claim comment and claim the task.`
          : named
            ? `${issue.identifier} is claimed by ${holder}, which this machine does not know and which was active at ${last}: replace_work_id may name another machine's work only after it has shown no activity for ${STALE_CLAIM_MS / 3_600_000} hours.`
            : `${issue.identifier} is already claimed by ${holder}.`,
        {
          work_id: entry.workId,
          ...(author === null
            ? {}
            : {
                holder_vendor: author.vendor,
                holder_session_id: author.sessionId,
              }),
          last_activity: last,
          ...(stale
            ? {
                stale_claim: true,
                comment_id: entry.comment.id,
                next_step: `work_claim ${JSON.stringify({ task_id: request.task_id, force_release: true })}`,
              }
            : {}),
        },
      );
    }
    for (const entry of closing)
      await writer.updateComment(
        entry.comment.id,
        withClaimStatus(
          entry.comment.body,
          `abandoned (closed by work ${workId})`,
        ),
        issue.id,
      );
    const author = authorOf(session);
    // 3. Write the claim; a replaced claim closes only after it landed.
    const claim = await api.createComment({
      id: freshId(),
      issueId: issue.id,
      body: renderClaimComment(author, workId, "open", now),
    });
    posted = claim;
    for (const entry of releasing)
      await writer.updateComment(
        entry.comment.id,
        withClaimStatus(
          entry.comment.body,
          `released (replaced by work ${workId})`,
        ),
        issue.id,
      );
    let current = issue;
    let agentLabel: { id: string; name: string } | undefined;
    if (writesLabelsAndStates(project)) {
      await writer.addOwnLabel(
        issue.id,
        workspace,
        "vc:claimed",
        vcLabelColor("vc:claimed"),
      );
      agentLabel = await writer.addOwnLabel(
        issue.id,
        workspace,
        session.agentLabel,
        AGENT_LABEL_COLOR,
        "Issues this coding agent claimed through vibecheck.",
      );
    }
    // The issue may have been finished while the claim was being written.
    const reread = writer.offline ? issue : await api.issue(issue.id);
    if (
      reread === null ||
      reread.stateType === "completed" ||
      reread.stateType === "canceled"
    ) {
      await writer.updateComment(
        claim.id,
        withClaimStatus(claim.body, "abandoned"),
        issue.id,
      );
      if (agentLabel !== undefined && !issue.labelIds.includes(agentLabel.id))
        await writer.removeLabel(issue.id, agentLabel);
      fail("conflict");
      await dropClaimLabel(deps, project, writer, issue.id, [workId]);
      throw new BoardError(
        "conflict",
        `${issue.identifier} was ${reread === null ? "deleted" : `moved to ${reread.stateName}`} while it was being claimed; a finished task cannot be claimed.`,
        { reason: "task_closed", identifier: issue.identifier },
      );
    }
    current = reread;
    if (writesLabelsAndStates(project)) {
      const { resolved } = await workspace.states();
      const assign =
        project.adoption !== "as_is" && current.assigneeId === null
          ? { assigneeId: (await workspace.viewer()).id }
          : {};
      if (current.stateType !== "started" || Object.keys(assign).length > 0)
        try {
          await moveIssue(
            deps,
            project,
            writer,
            issue,
            current.stateType === "started"
              ? current.stateId
              : resolved.inProgress.id,
            assign,
            { stateId: current.stateId },
          );
        } catch (error) {
          // The issue left the project while it was being claimed.
          if (error instanceof BoardError)
            await writer.updateComment(
              claim.id,
              withClaimStatus(claim.body, "abandoned"),
              issue.id,
            );
          throw error;
        }
    }
    // 4. Re-read: the earliest open claim comment wins.
    const after = await claimComments(api, issue.id);
    const winner = after[0];
    if (winner !== undefined && winner.workId !== workId) {
      await api.updateComment(
        claim.id,
        withClaimStatus(claim.body, "released (lost claim race)"),
      );
      // The winner keeps vc:claimed; the loser takes back its agent label
      // unless the issue had it before or the winner is the same vendor.
      const winnerVendor = /^\*\*Claimed\*\* by (.+?) \(/u.exec(
        winner.comment.body,
      )?.[1];
      if (
        agentLabel !== undefined &&
        !issue.labelIds.includes(agentLabel.id) &&
        (winnerVendor === undefined ||
          agentLabelName(winnerVendor) !== session.agentLabel)
      )
        await writer.removeLabel(issue.id, agentLabel);
      fail("conflict");
      throw new BoardError(
        "conflict",
        `Another agent claimed ${issue.identifier} first: work ${winner.workId} holds it.`,
        { work_id: winner.workId },
      );
    }
    const claimedRow: WorkRow = {
      ...row,
      claimCommentId: claim.id,
      revision: 2,
      updatedAt: deps.now().toISOString(),
    };
    store.putWork(claimedRow);
    // A new claim starts a new completion: earlier verdicts stop speaking
    // for the task, here (the floor) and in Linear (the labels). Held work
    // that was replaced or force-released is no longer open either.
    setVerdictFloor(store, project.key, issue.id, issue.identifier, "claimed");
    if (writesLabelsAndStates(project)) {
      // The issue was read from Linear for this claim: only verdict labels
      // it carries are removed.
      const names = await workspace.labelNames(issue.labelIds);
      for (const id of issue.labelIds) {
        const name = names.get(id);
        if (
          name === "vc:verified" ||
          name === "vc:unverified" ||
          name === "vc:held"
        )
          await writer.removeNamedLabel(issue.id, workspace, name);
      }
    }
    // The claim stands: a failed read for the cache does not undo it.
    try {
      current = (await api.issue(issue.id)) ?? current;
    } catch (error) {
      if (!isLinearError(error, "network", "server", "rate_limited"))
        throw error;
    }
    store.cacheIssues(project.key, [current]);
    let verification: VerificationItem[] = [];
    if (deps.verifier !== undefined) {
      const snapshot = await snapshotFor(deps, project, workspace);
      const task =
        snapshot.tasks.find((entry) => entry.issueId === issue.id) ??
        taskView(
          current,
          key,
          await workspace.labelNames(current.labelIds),
          null,
        );
      const pending = await deps.verifier.afterClaim(
        snapshot,
        claimedRow,
        task,
      );
      verification = record(deps, pending);
      await relateOverlaps(
        deps,
        project,
        writer,
        issue.id,
        pending,
        verification,
      );
    }
    // Attention on the issue goes back with the claim. Everything it returns
    // except a person's reply (answered only by a report) is cleared: a new
    // claim answers a skipped move, and an earlier lost claim, removal or
    // reopening of the issue has now been shown.
    const attention = pendingAttention(
      store,
      project.key,
      new Set([issue.id]),
      () => key,
    );
    store.transaction(() => {
      for (const event of attention.events)
        if (event.kind !== "human_reply") store.clearEvent(event.id);
    });
    return {
      work: workResult(claimedRow, key),
      issue: issueResult(current),
      ...(attention.items.length === 0 ? {} : { attention: attention.items }),
      ...(verification.length === 0 ? {} : { verification }),
      sync: { pending: store.pendingCount() },
    };
  } catch (error) {
    if (!(error instanceof BoardError)) {
      const stored = store.work(workId);
      // This machine closes its own claim: the row says so before the
      // comment does, so the reconciler never takes the close for a lost
      // claim. A claim comment that landed must not stay open.
      if (
        stored !== undefined &&
        stored.status === "in_progress" &&
        (stored.claimCommentId === null || posted !== undefined)
      )
        store.putWork({
          ...stored,
          status: "released",
          revision: stored.revision + 1,
          updatedAt: deps.now().toISOString(),
        });
      if (posted !== undefined) {
        store.enqueue({
          projectKey: project.key,
          kind: "update_comment",
          payload: {
            id: posted.id,
            body: withClaimStatus(posted.body, "released"),
          },
        });
        // Sent only while no claim comment on the issue reads open.
        if (writesLabelsAndStates(project))
          store.enqueue({
            projectKey: project.key,
            kind: "remove_label",
            payload: { issueId: issue.id, labelName: "vc:claimed" },
          });
      }
    }
    throw error;
  }
}

function reportKind(change: WorkChange, status: string): ReportKind {
  if (change.action === "release") return "Released";
  if (change.action === "handoff") return "Handoff";
  if (status === "complete") return "Done";
  if (status === "blocked") return "Blocked";
  return "Progress";
}

function validateWork(work: WorkRow): void {
  if (
    work.status === "blocked" &&
    (work.blocker === null || work.blocker === "")
  )
    throw new BoardError("invalid", "Blocked work requires a blocker.", {
      work_id: work.id,
    });
  if (
    work.status === "awaiting_integration" &&
    (work.commit === null || work.location.targetBranch === null)
  )
    throw new BoardError(
      "invalid",
      "Work awaiting integration requires a commit and a target branch.",
      { work_id: work.id },
    );
  if (
    work.status === "complete" &&
    work.integrationRequired &&
    work.integrationCommit === null
  )
    throw new BoardError(
      "invalid",
      "Completing work that awaited integration requires an integration commit.",
      { work_id: work.id },
    );
}

/** The work row as a progress change leaves it, before checks decide completion. */
function applyProgress(
  work: WorkRow,
  change: Extract<WorkChange, { action?: "progress" | undefined }>,
  now: string,
): WorkRow {
  const status = change.status ?? work.status;
  let updated: WorkRow = {
    ...work,
    status,
    ...(change.blocker === undefined ? {} : { blocker: change.blocker }),
    ...(change.commit === undefined ? {} : { commit: change.commit }),
    ...(change.integration_commit === undefined
      ? {}
      : { integrationCommit: change.integration_commit }),
    revision: work.revision + 1,
    updatedAt: now,
  };
  if (change.location !== undefined)
    updated = {
      ...updated,
      location:
        change.location === null
          ? locationRecord(undefined)
          : mergeLocation(work.location, change.location),
    };
  if (
    change.integration_commit === undefined &&
    (updated.commit !== work.commit ||
      updated.location.targetBranch !== work.location.targetBranch ||
      updated.location.repository !== work.location.repository)
  )
    updated = { ...updated, integrationCommit: null };
  return {
    ...updated,
    integrationRequired:
      work.integrationRequired || status === "awaiting_integration",
  };
}

function isProgress(
  change: WorkChange,
): change is Extract<WorkChange, { action?: "progress" | undefined }> {
  return change.action === undefined || change.action === "progress";
}

/** What blocker triage said this work needs (`user`, `agent`, ...), if it ran. */
function triageNeeds(
  pending: readonly PendingEntry[],
  workId: string,
): string | undefined {
  for (const { subject, entry } of pending) {
    if (
      subject.workId !== workId ||
      entry.kind !== "verdict" ||
      entry.body.battery_id !== "vibecheck.blocker-triage"
    )
      continue;
    const decision = entry.body.decision;
    if (
      typeof decision !== "object" ||
      decision === null ||
      Array.isArray(decision)
    )
      return undefined;
    const needs = Object.entries(decision).find(([name]) => name === "needs");
    return typeof needs?.[1] === "string" ? needs[1] : undefined;
  }
  return undefined;
}

/** One change's outcome in a work_update result. */
interface ChangeOutcome {
  readonly work_id: string;
  readonly outcome: "applied" | "failed";
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: BoardErrorDetails;
  };
  /** A completion, release or handoff recorded and not finished, or given up. */
  readonly completion?: "pending" | "abandoned";
}

/** A check result as the steps of a change read it. */
type ItemView = Pick<VerificationItem, "check" | "outcome" | "reason">;

interface ApplyInput {
  readonly deps: LedgerDeps;
  readonly project: ProjectRow;
  readonly session: SessionRow;
  readonly context: ChangeContext;
  readonly items: readonly ItemView[];
  /** Work whose completion the done checks hold, with the reason. */
  readonly holds: ReadonlyMap<WorkId, string>;
  /** Every entry the checks produced (blocker triage is read from them). */
  readonly pending: readonly PendingEntry[];
  readonly writer: Writer;
  readonly workspace: Workspace;
  readonly now: string;
  /** The work_update's request id: comment ids derive from it. */
  readonly requestId: string;
}

interface Applied {
  readonly shown: readonly Readonly<Record<string, unknown>>[];
  readonly taskStatus: string;
}

/**
 * The id of a comment a change creates, derived from the session, the
 * request id, the work and the comment's purpose: a retry of the same
 * request never posts it twice, and two sessions that reuse a request id
 * never share one.
 */
function changeCommentId(
  sessionId: string,
  requestId: string,
  workId: string,
  purpose: string,
): string {
  return stableId("work_update", sessionId, requestId, workId, purpose);
}

/** Verdict comments: failures, flags and reviews, and one verified note. */
function verdictComments(
  author: CommentAuthor,
  items: readonly ItemView[],
  held: boolean,
  commentId: (purpose: string) => string,
): Extract<CompletionStep, { readonly kind: "comment" }>[] {
  const comments: Extract<CompletionStep, { readonly kind: "comment" }>[] = [];
  for (const [index, item] of items.entries())
    if (
      item.outcome === "failed" ||
      item.outcome === "flagged" ||
      item.outcome === "review"
    )
      comments.push({
        kind: "comment",
        id: commentId(`verdict:${index}:${item.check}`),
        body: renderVerdictComment(
          author,
          item.check,
          item.outcome,
          item.reason,
        ),
      });
  const claimsDone = items.find(
    (item) =>
      item.check === "vibecheck.claims-done" && item.outcome === "passed",
  );
  if (claimsDone !== undefined && !held && doneItemsVerified(items))
    comments.push({
      kind: "comment",
      id: commentId("verified"),
      body: renderVerdictComment(
        author,
        claimsDone.check,
        "verified",
        claimsDone.reason,
      ),
    });
  return comments;
}

/** Whether a change closes its claim or decides a completion: it runs as a completion plan. */
function isClosing(change: WorkChange): boolean {
  return (
    change.action === "release" ||
    change.action === "handoff" ||
    (isProgress(change) && change.status === "complete")
  );
}

/**
 * The completion plan of a closing change (a completion, held or not, a
 * release or a handoff): the decision, the closing status and the ordered
 * Linear steps, decided before any Linear write.
 */
async function completionFor(input: ApplyInput): Promise<CompletionRow> {
  const { deps, project, session, context, items, workspace, now } = input;
  const { store } = deps;
  const { change, work, task } = context;
  const labels = writesLabelsAndStates(project);
  const cached = store
    .cachedIssues(project.key)
    .find((entry) => entry.id === work.issueId);
  // The tool's own queued moves of the issue (an earlier change's move that
  // could not be sent): their target is an expected state too.
  const queued = store
    .events(project.key, { kinds: ["expected_move"] })
    .filter((event) => event.issueId === work.issueId)
    .flatMap((event) => {
      const target = event.body["stateId"];
      return typeof target === "string" && target !== cached?.stateId
        ? [target]
        : [];
    });
  const expectation = {
    expectStateId: cached?.stateId ?? null,
    ...(queued.length === 0 ? {} : { alsoExpect: [...new Set(queued)] }),
  };
  const author = authorOf(session);
  const commentId = (purpose: string) =>
    changeCommentId(session.id, input.requestId, work.id, purpose);
  const hold = input.holds.get(work.id);
  const steps: CompletionStep[] = [];
  const add = (name: VcLabelName) => {
    if (labels) steps.push({ kind: "add_label", name });
  };
  const remove = (...names: readonly VcLabelName[]) => {
    if (labels)
      for (const name of names) steps.push({ kind: "remove_label", name });
  };
  const report = (kind: ReportKind, text: string | undefined) => {
    if (text !== undefined)
      steps.push({
        kind: "comment",
        id: commentId("report"),
        body: renderReportComment(author, kind, text),
      });
  };
  const verdicts = () =>
    steps.push(
      ...verdictComments(author, items, hold !== undefined, commentId),
    );
  const stalled = () => {
    const check = items.find((item) => item.check === "vibecheck.stalled");
    if (check?.outcome === "flagged") add("vc:stalled");
    else if (check !== undefined && check.outcome !== "unavailable")
      remove("vc:stalled");
  };
  const close = () => {
    if (work.claimCommentId !== null) steps.push({ kind: "close_claim" });
  };
  const base = {
    id: completionId(work.id, session.id, input.requestId),
    projectKey: project.key,
    workId: work.id,
    sessionId: session.id,
    requestId: input.requestId,
    issueId: work.issueId,
    identifier: work.identifier,
    taskKey: task.key,
    steps,
    done: 0,
    reason: null,
    attempts: 0,
    changeHash: changeHash(change),
    change: { ...change },
    verification: [],
    createdAt: now,
    updatedAt: now,
  };
  const released: WorkRow = {
    ...work,
    status: "released",
    revision: work.revision + 1,
    updatedAt: now,
  };

  if (change.action === "release") {
    let taskStatus = task.status;
    if (labels && task.status !== "complete" && task.status !== "cancelled") {
      const todo = await workspace.firstState("unstarted", "backlog");
      if (todo !== undefined)
        steps.push({
          kind: "move",
          stateId: todo.id,
          ...expectation,
          required: false,
        });
      taskStatus = "pending";
    }
    remove("vc:blocked", "vc:held", "vc:stalled", "vc:needs-user");
    report("Released", change.report);
    verdicts();
    close();
    if (labels) steps.push({ kind: "drop_claimed" });
    return {
      ...base,
      state: "pending",
      kind: "release",
      decision: null,
      closingStatus: "released",
      rows: [released],
      taskStatus,
    };
  }

  if (change.action === "handoff") {
    const target = requireSession(
      store,
      project,
      sessionIdOf(change.handoff_to),
    );
    const successorId = workIdOf(
      `w_${commentId("successor").replaceAll("-", "")}`,
    );
    const claimId = commentId("handoff-claim");
    const successor: WorkRow = {
      ...work,
      id: successorId,
      sessionId: target.id,
      claimCommentId: claimId,
      predecessorWorkId: work.id,
      revision: 2,
      createdAt: now,
      updatedAt: now,
    };
    if (labels) steps.push({ kind: "agent_label", name: target.agentLabel });
    remove("vc:stalled");
    report("Handoff", change.report);
    verdicts();
    // The successor's claim lands before this one closes: no gap.
    steps.push({
      kind: "comment",
      id: claimId,
      body: renderClaimComment(authorOf(target), successorId, "open", now),
    });
    close();
    return {
      ...base,
      state: "pending",
      kind: "handoff",
      decision: null,
      closingStatus: `handed off to work ${successorId}`,
      rows: [released, successor],
      taskStatus: task.status,
    };
  }

  const next = isProgress(change) ? applyProgress(work, change, now) : work;
  if (hold !== undefined) {
    // Held: the claim stays open and the issue is never moved.
    if (work.claimCommentId !== null) steps.push({ kind: "activity", at: now });
    add("vc:held");
    remove("vc:verified");
    if (items.some((item) => item.outcome === "unavailable"))
      add("vc:unverified");
    stalled();
    report("Done", change.report);
    verdicts();
    return {
      ...base,
      state: "pending",
      kind: "complete",
      decision: "held",
      closingStatus: null,
      rows: [{ ...next, status: work.status }],
      taskStatus: task.status,
    };
  }
  const verified = deps.verifier !== undefined && doneItemsVerified(items);
  if (labels) {
    const { resolved } = await workspace.states();
    steps.push({
      kind: "move",
      stateId: resolved.done.id,
      ...expectation,
      required: true,
    });
  }
  if (verified) {
    add("vc:verified");
    remove("vc:held", "vc:unverified");
  } else {
    add("vc:unverified");
    remove("vc:held", "vc:verified");
  }
  remove(
    "vc:blocked",
    "vc:awaiting-integration",
    "vc:stalled",
    "vc:needs-user",
  );
  stalled();
  report("Done", change.report);
  verdicts();
  close();
  if (labels) steps.push({ kind: "drop_claimed" });
  return {
    ...base,
    state: "pending",
    kind: "complete",
    decision: verified ? "verified" : "unverified",
    closingStatus: "complete",
    rows: [next],
    taskStatus: "complete",
  };
}

/**
 * Applies a change that keeps the claim open and decides no completion:
 * every Linear write first (sent or queued), then the local row, the report
 * history and a marker that this change of this request landed, in one
 * transaction. A Linear failure that is not a lost connection aborts the
 * change before the local commit, so the work stays as it was and the
 * change can be retried; comments carry ids derived from the session, the
 * request id, the work and their purpose, so a retry never posts one twice.
 * The claim's activity is recorded first, on the claim comment as it stands
 * in Linear: one that was deleted or closed by someone else loses the claim
 * and nothing else is written.
 */
async function applyProgressChange(input: ApplyInput): Promise<Applied> {
  const { deps, project, session, context, items, writer, workspace, now } =
    input;
  const { store } = deps;
  const { change, work, task } = context;
  if (!isProgress(change))
    throw new Error("only progress changes apply directly");
  const author = authorOf(session);
  const workAuthor = authorOf(store.session(work.sessionId) ?? session);
  const labels = writesLabelsAndStates(project);
  const { resolved } = await workspace.states();
  const issue = store
    .cachedIssues(project.key)
    .find((entry) => entry.id === work.issueId);
  const expect: MoveExpectation = { stateId: issue?.stateId };
  const commentId = (purpose: string) =>
    changeCommentId(session.id, input.requestId, work.id, purpose);
  const addVc = async (name: VcLabelName) => {
    if (labels)
      await writer.addOwnLabel(
        work.issueId,
        workspace,
        name,
        vcLabelColor(name),
      );
  };
  // Removing looks the label up without creating it, and never trusts the
  // cache: removing a label the issue does not carry changes nothing.
  const removeVc = async (...names: readonly VcLabelName[]) => {
    if (!labels) return;
    for (const name of names)
      await writer.removeNamedLabel(work.issueId, workspace, name);
  };
  const move = (stateId: string) =>
    moveIssue(
      deps,
      project,
      writer,
      { id: work.issueId, identifier: work.identifier },
      stateId,
      {},
      expect,
    );

  if (work.claimCommentId !== null) {
    const recorded = await writer.claimActivity({
      commentId: work.claimCommentId,
      issueId: work.issueId,
      workId: work.id,
      at: now,
      body: renderClaimComment(workAuthor, work.id, "open", now),
    });
    if (recorded === "lost") {
      let comments: readonly Comment[] = [];
      try {
        comments = await deps.linear().comments(work.issueId);
      } catch (error) {
        if (!isLinearError(error)) throw error;
      }
      const reason =
        lostClaim(work, comments, ownClosingStatuses(store, work.id)) ??
        `the claim comment of work ${work.id} on ${work.identifier} no longer reads open in Linear; work ${work.id} was released here: stop working on it and claim the task again only if it is free`;
      markClaimLost(store, project, work, reason, now);
      throw new BoardError(
        "conflict",
        `Work ${work.id} lost its claim on ${work.identifier}: ${reason}.`,
        { work_id: work.id, status: "released", reason: "claim_lost" },
      );
    }
  }

  const requested = change.status ?? work.status;
  const updated = applyProgress(work, change, now);
  const needs = triageNeeds(input.pending, work.id);
  if (requested === "blocked") {
    await addVc("vc:blocked");
    await removeVc("vc:awaiting-integration");
    if (needs === "user") await addVc("vc:needs-user");
    else if (needs !== undefined) await removeVc("vc:needs-user");
  } else if (requested === "awaiting_integration") {
    await removeVc("vc:blocked", "vc:needs-user");
    if (resolved.review !== null) {
      if (labels) await move(resolved.review.id);
    } else await addVc("vc:awaiting-integration");
  } else {
    await removeVc("vc:blocked", "vc:needs-user", "vc:awaiting-integration");
    if (
      labels &&
      resolved.review !== null &&
      issue?.stateId === resolved.review.id
    )
      await move(resolved.inProgress.id);
  }
  const stalled = items.find((item) => item.check === "vibecheck.stalled");
  if (stalled?.outcome === "flagged") await addVc("vc:stalled");
  else if (stalled !== undefined && stalled.outcome !== "unavailable")
    await removeVc("vc:stalled");
  const text =
    change.report ??
    (requested === "blocked" &&
    change.blocker != null &&
    change.blocker !== work.blocker
      ? change.blocker
      : undefined);
  if (text !== undefined)
    await writer.comment(
      work.issueId,
      renderReportComment(author, reportKind(change, requested), text),
      commentId("report"),
    );
  for (const step of verdictComments(
    author,
    items,
    input.holds.has(work.id),
    commentId,
  ))
    await writer.comment(work.issueId, step.body, step.id);

  // Linear is written (or queued): commit the local state last, with the
  // marker that this change of this request landed.
  const applied: AppliedRecord = {
    shown: [workResult(updated, task.key)],
    task: {
      task_id: task.key,
      identifier: task.identifier,
      status: requested,
    },
  };
  const access = store.verificationAccess();
  store.transaction(() => {
    store.putWork(updated);
    recordReport(access, task.key, updated, change, session.id);
    store.putReceipt(
      appliedScope(project.key, session.id),
      appliedKey(input.requestId, work.id),
      changeHash(change),
      applied,
    );
  });
  return { shown: applied.shown, taskStatus: requested };
}

/** One change of a batch: a new change, or a recorded plan to resume. */
type Job =
  | {
      readonly kind: "new";
      readonly work: WorkRow;
      readonly context: ChangeContext;
    }
  | {
      readonly kind: "resume";
      readonly work: WorkRow;
      readonly change: WorkChange;
      readonly row: CompletionRow;
    };

export async function workUpdate(deps: LedgerDeps, request: WorkUpdate) {
  const { store } = deps;
  let project = requireProject(store, projectKeyOf(request.project_id));
  requireAdopted(project);
  requireLinked(project);
  const session = requireSession(
    store,
    project,
    sessionIdOf(request.session_id),
  );
  const ids = request.updates.map((change) => change.work_id);
  if (new Set(ids).size !== ids.length)
    throw new BoardError(
      "invalid",
      "A work record may appear only once in an update batch.",
    );
  const api = deps.linear();
  const workspace = workspaceFor(deps, project.teamId);
  try {
    await reconcile(deps, project);
  } catch (error) {
    // Linear unreachable: judge from the cache; writes below queue.
    if (!isLinearError(error, "network", "server", "rate_limited")) throw error;
  }
  project = requireProject(store, project.key);
  const snapshot = await snapshotFor(deps, project, workspace);
  const now = deps.now().toISOString();
  const access = store.verificationAccess();

  // Validate the whole batch before any write. A change this request
  // already applied (a retry after part of the batch failed) is not run
  // again: it is reported as applied. A closing change this request already
  // recorded as a plan resumes that plan, with its decision, unjudged.
  const jobs: Job[] = [];
  const landed: { work_id: string; record: AppliedRecord }[] = [];
  for (const change of request.updates) {
    const work = store.work(workIdOf(change.work_id));
    if (work === undefined || work.projectKey !== project.key)
      throw new BoardError(
        "not_found",
        `Work ${change.work_id} does not exist.`,
      );
    const marker = store.receipt(
      appliedScope(project.key, session.id),
      appliedKey(request.request_id, work.id),
    );
    if (marker !== undefined) {
      if (marker.inputHash !== changeHash(change))
        throw new BoardError(
          "conflict",
          "request_id was already used with different input",
          { work_id: work.id },
        );
      landed.push({
        work_id: work.id,
        record: appliedSchema.parse(marker.result),
      });
      continue;
    }
    const planId = completionId(work.id, session.id, request.request_id);
    const recorded = store.completion(planId);
    if (recorded !== undefined) {
      if (recorded.changeHash !== changeHash(change))
        throw new BoardError(
          "conflict",
          "request_id was already used with different input",
          { work_id: work.id },
        );
      jobs.push({ kind: "resume", work, change, row: recorded });
      continue;
    }
    if (!OPEN_WORK.has(work.status)) {
      // The same change, already finished by a plan (resumed by an earlier
      // call): reported as applied.
      const finished = store
        .completionsForWork(work.id)
        .find(
          (row) =>
            row.state === "done" && row.changeHash === changeHash(change),
        );
      if (finished !== undefined) {
        // Only the work's session or the coordinator may see it as theirs.
        if (
          work.sessionId !== session.id &&
          project.coordinatorSessionId !== session.id
        )
          throw new BoardError(
            "forbidden",
            "Only the work's session or the coordinator can update it.",
          );
        landed.push({ work_id: work.id, record: appliedOf(finished) });
        continue;
      }
      const lost = store
        .events(project.key, { kinds: ["claim_lost"], all: true })
        .find((event) => event.workId === work.id);
      if (lost !== undefined) {
        const reason = lost.body["reason"];
        throw new BoardError(
          "conflict",
          `Work ${work.id} lost its claim on ${work.identifier}: ${typeof reason === "string" ? reason : "its claim comment was closed in Linear"}.`,
          { work_id: work.id, status: work.status, reason: "claim_lost" },
        );
      }
      throw new BoardError(
        "conflict",
        `Work ${work.id} is ${work.status}; only open work can change.`,
        { work_id: work.id, status: work.status },
      );
    }
    if (
      work.sessionId !== session.id &&
      project.coordinatorSessionId !== session.id
    )
      throw new BoardError(
        "forbidden",
        "Only the work's session or the coordinator can update it.",
      );
    // The same change, already finished by a plan while the work stays open
    // (a held completion resumed by an earlier call): reported as applied,
    // never judged again, as long as nothing changed the work since.
    const latest = store.completionsForWork(work.id).at(-1);
    const committed = latest?.rows[0];
    if (
      latest !== undefined &&
      latest.state === "done" &&
      latest.changeHash === changeHash(change) &&
      committed !== undefined &&
      committed.revision === work.revision &&
      committed.updatedAt === work.updatedAt
    ) {
      landed.push({ work_id: work.id, record: appliedOf(latest) });
      continue;
    }
    const other = otherPendingCompletion(deps, work.id, planId);
    // The same change recorded by another request: resume that plan.
    if (other !== undefined && other.changeHash === changeHash(change)) {
      jobs.push({ kind: "resume", work, change, row: other });
      continue;
    }
    if (other !== undefined)
      throw new BoardError(
        "conflict",
        `Work ${work.id} has a ${other.kind === "complete" ? "completion" : other.kind} recorded by request ${other.requestId} that is not finished in Linear (${other.done} of ${other.steps.length} steps done${other.reason === null ? "" : `; last failure: ${other.reason}`}). It resumes on the next tool call; repeat that request with the same request_id to resume it now.`,
        {
          work_id: work.id,
          completion: "pending",
          request_id: other.requestId,
        },
      );
    if (change.action === "handoff")
      requireSession(store, project, sessionIdOf(change.handoff_to));
    let task: TaskView | undefined = snapshot.tasks.find(
      (entry) => entry.issueId === work.issueId,
    );
    if (task === undefined) {
      const issue = await api.issue(work.issueId);
      if (issue === null || issue.projectId !== project.linearProjectId)
        throw new BoardError(
          "not_found",
          `${work.identifier} is no longer in project ${project.key} in Linear.`,
          { work_id: work.id },
        );
      store.cacheIssues(project.key, [issue]);
      task = taskView(
        issue,
        keyFor(project, deps, issue),
        await workspace.labelNames(issue.labelIds),
        null,
      );
    }
    if (isProgress(change)) validateWork(applyProgress(work, change, now));
    const completing = isProgress(change) && change.status === "complete";
    const children = completing
      ? childrenOf(snapshot, task).map((child) => ({
          key: child.key,
          verified: isVerified(
            access,
            project.key,
            [child.key, child.identifier],
            child.status,
          ),
        }))
      : [];
    let pullRequests: ChangeContext["pullRequests"] = [];
    if (completing) {
      try {
        pullRequests = await api.pullRequests(work.issueId);
      } catch {
        pullRequests = [];
      }
    }
    jobs.push({
      kind: "new",
      work,
      context: {
        change,
        work,
        task,
        previousReports: previousReports(access, project.key, work.id),
        children,
        pullRequests,
      },
    });
  }

  const contexts = jobs.flatMap((job) =>
    job.kind === "new" ? [job.context] : [],
  );
  const checked: WorkUpdatePlan =
    deps.verifier === undefined || contexts.length === 0
      ? { holds: new Map(), pending: [] }
      : await deps.verifier.checkWorkUpdate(snapshot, contexts);
  // A closing change records its entries with its plan, in one transaction
  // before any Linear write; the others are recorded now.
  const closing = new Set<string>(
    contexts
      .filter((context) => isClosing(context.change))
      .map((context) => context.work.id),
  );
  const entriesOf = (workId: string) =>
    checked.pending.filter((entry) => entry.subject.workId === workId);
  const verification: Readonly<Record<string, unknown>>[] = [];
  const progressItems = record(
    deps,
    checked.pending.filter(
      (entry) =>
        entry.subject.workId == null || !closing.has(entry.subject.workId),
    ),
  );
  verification.push(...progressItems.map((item) => ({ ...item })));
  const byWork = new Map<string, VerificationItem[]>();
  for (const item of progressItems)
    if (item.work_id !== undefined)
      byWork.set(item.work_id, [...(byWork.get(item.work_id) ?? []), item]);

  const writer = new Writer(store, api, project.key);
  const changedWork: Readonly<Record<string, unknown>>[] = [];
  const changedTasks: {
    task_id: string;
    identifier: string;
    status: string;
  }[] = [];
  const outcomes = new Map<string, ChangeOutcome>();
  const issueKeys = new Map<string, string>();
  for (const { work_id, record: done } of landed) {
    changedWork.push(...done.shown);
    changedTasks.push(done.task);
    outcomes.set(work_id, { work_id, outcome: "applied" });
    const work = store.work(workIdOf(work_id));
    if (work !== undefined) issueKeys.set(work.issueId, done.task.task_id);
  }
  // Issues whose change landed in this call, and those it answered with a report.
  const answered = new Set<string>();
  const replied = new Set<string>();
  const single = jobs.length + landed.length === 1;
  for (const job of jobs) {
    const change = job.kind === "new" ? job.context.change : job.change;
    issueKeys.set(
      job.work.issueId,
      job.kind === "new" ? job.context.task.key : job.row.taskKey,
    );
    let pendingPlan: "pending" | "abandoned" | undefined;
    try {
      let shown: readonly Readonly<Record<string, unknown>>[];
      let task: { task_id: string; identifier: string; status: string };
      if (job.kind === "new" && !closing.has(job.work.id)) {
        const applied = await applyProgressChange({
          deps,
          project,
          session,
          context: job.context,
          items: byWork.get(job.work.id) ?? [],
          holds: checked.holds,
          pending: checked.pending,
          writer,
          workspace,
          now,
          requestId: request.request_id,
        });
        shown = applied.shown;
        task = {
          task_id: job.context.task.key,
          identifier: job.context.task.identifier,
          status: applied.taskStatus,
        };
      } else {
        let row: CompletionRow;
        if (job.kind === "resume") {
          row = job.row;
          verification.push(...row.verification);
        } else {
          const entries = entriesOf(job.work.id);
          const planned = await completionFor({
            deps,
            project,
            session,
            context: job.context,
            items: entries.map(({ entry }) => describeEntry(entry)),
            holds: checked.holds,
            pending: checked.pending,
            writer,
            workspace,
            now,
            requestId: request.request_id,
          });
          // The decision and its entries are committed together, before
          // the first Linear write.
          row = store.transaction(() => {
            const items = recordEntries(access, entries);
            const recorded: CompletionRow = {
              ...planned,
              verification: items.map((item) => ({ ...item })),
            };
            store.putCompletion(recorded);
            return recorded;
          });
          verification.push(...row.verification);
        }
        const outcome = await runCompletion(deps, row);
        if (outcome.applied === undefined) {
          pendingPlan =
            outcome.row.state === "pending" ? "pending" : "abandoned";
          throw (
            outcome.error ??
            new BoardError("unavailable", "The completion did not finish.")
          );
        }
        shown = outcome.applied.shown;
        task = outcome.applied.task;
      }
      changedWork.push(...shown);
      changedTasks.push(task);
      outcomes.set(job.work.id, { work_id: job.work.id, outcome: "applied" });
      answered.add(job.work.issueId);
      if (change.report !== undefined) replied.add(job.work.issueId);
    } catch (error) {
      // A single change reports its failure as the call's error; in a batch
      // each change stands alone and the result lists what failed.
      if (single) throw error;
      const failure =
        error instanceof BoardError
          ? error
          : isLinearError(error)
            ? boardErrorFor(error)
            : undefined;
      if (failure === undefined) throw error;
      outcomes.set(job.work.id, {
        work_id: job.work.id,
        outcome: "failed",
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.details === undefined
            ? {}
            : { details: failure.details }),
        },
        ...(pendingPlan === undefined ? {} : { completion: pendingPlan }),
      });
    }
  }

  // Attention on the touched issues goes back with the result. Only events
  // returned here are cleared: a reply only by a report on that work, a
  // skipped move by any change that landed on the issue, and a lost claim,
  // removal, reopening or held completion moved to done once shown.
  const attention = pendingAttention(
    store,
    project.key,
    new Set(issueKeys.keys()),
    (event) => issueKeys.get(event.issueId) ?? event.identifier,
  );
  store.transaction(() => {
    for (const event of attention.events)
      if (
        (event.kind === "human_reply" && replied.has(event.issueId)) ||
        (event.kind === "skipped_move" && answered.has(event.issueId)) ||
        event.kind === "claim_lost" ||
        event.kind === "removed" ||
        event.kind === "reopened" ||
        event.kind === "held_done_moved"
      )
        store.clearEvent(event.id);
  });
  const waiting = store.events(project.key, { kinds: ["recheck"] }).length;
  const completions = store.pendingCompletions(project.key).length;
  return {
    work: changedWork,
    tasks: changedTasks,
    results: request.updates.flatMap((change) => {
      const outcome = outcomes.get(workIdOf(change.work_id));
      return outcome === undefined ? [] : [outcome];
    }),
    ...(attention.items.length === 0 ? {} : { attention: attention.items }),
    ...(verification.length === 0 ? {} : { verification }),
    sync: {
      pending: store.pendingCount(),
      ...(waiting === 0 ? {} : { pending_rechecks: waiting }),
      ...(completions === 0 ? {} : { pending_completions: completions }),
    },
  };
}
