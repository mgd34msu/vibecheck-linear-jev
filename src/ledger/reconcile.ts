// The reconciler: what changed in Linear outside the tool.
//
// Runs at the start of project_status and work_update, and in `sync`. It
// pages the project's issues updated since the cursor (minus a short overlap,
// so issues updated in the cursor's own millisecond are not missed; an issue
// whose cached copy is identical was seen already), refreshes the
// local cache and advances the cursor, then for each changed issue:
//
//   newly completed with no passing done check   queue a done re-check
//     (not by this machine's own move)            and move the verdict floor
//   left a completed state                        attention `reopened`, the
//                                                  verdict floor moves
//   seen not complete with verdict labels         stale ones removed
//   verdict labels the local entries do not       verdict floor moves
//     explain (complete issue)
//   archived, deleted or moved out of the project work abandoned, `removed`,
//     while a local claim is open                 claim comment closed
//   description changed                           cache only
//
// Every issue with an open local claim is also read directly: one that is no
// longer in the project counts as moved even when the project page cannot
// show it. Comments do not change an issue's updatedAt, so those issues have
// their comments read too: a person's comment after the claim's last claim or
// report comment becomes attention `human_reply`, and an open claim whose
// claim comment someone else closed (another machine's force_release or
// replace_work_id, or a person's edit) makes the work `released` with
// attention `claim_lost`. A state the tool's own queued move brings the
// issue to (recorded as an expected move) is not taken for a person's move.
// At most
// `linear.reconcile.maxRechecks` re-checks run per call; the rest wait, and a
// re-check that fails part-way stays queued for the next run. A re-check that
// fails or cannot be read adds `vc:unverified` and a verdict comment, except
// in as-is projects on issues no agent of this tool claimed, where the result
// stays in local history and the attention list. The tool never moves an
// issue a person moved.

import { isDeepStrictEqual } from "node:util";
import type { Comment, Issue, LinearApi } from "../linear/api.js";
import { isLinearError } from "../linear/errors.js";
import { parsePolicyDocument } from "../linear/documents.js";
import {
  isReportComment,
  isToolComment,
  parseClaimComment,
  renderVerdictComment,
  unescapeCommentText,
  type CommentAuthor,
} from "../linear/states.js";
import type { EventRow, ProjectRow, WorkRow } from "../local/types.js";
import { DEFAULT_MAX_RECHECKS } from "../jev/config.js";
import {
  doneItemsVerified,
  latestDoneOutcome,
  recordEntries,
  type PendingEntry,
} from "../verification/ledger.js";
import { deterministicEntry } from "../jev/entries.js";
import {
  OPEN_WORK,
  currentRevision,
  vcLabelColor,
  writesLabelsAndStates,
} from "./access.js";
import {
  closeClaim,
  endCompletions,
  lostClaim,
  markClaimLost,
  ownClosingStatuses,
} from "./claims.js";
import {
  stableId,
  workspaceFor,
  Writer,
  type LedgerDeps,
  type Workspace,
} from "./context.js";
import { buildSnapshot, keysOf, taskView } from "./snapshot.js";
import { currentDoneOutcome, setVerdictFloor } from "./verdicts.js";
import { labelsExplained } from "../verification/status.js";

export interface ReconcileResult {
  /** Issues whose cached copy changed. */
  readonly changed: number;
  readonly rechecked: number;
  /** Re-checks still queued for a later run. */
  readonly waiting: number;
  /** Writes queued because Linear stopped answering mid-run. */
  readonly queued: number;
}

const NONE: ReconcileResult = {
  changed: 0,
  rechecked: 0,
  waiting: 0,
  queued: 0,
};
const REPLY_LIMIT = 280;
/** How far before the cursor each page starts, so same-millisecond updates are read. */
const CURSOR_OVERLAP_MS = 1000;
/**
 * A claim row still without its claim comment after this long was cut off
 * between the local write and Linear (a crash): it is settled from Linear.
 */
export const PENDING_CLAIM_MS = 10 * 60 * 1000;

/** The author line for comments the reconciler writes on no session's behalf. */
const RECONCILER: CommentAuthor = {
  vendor: "vibecheck",
  model: "reconciler",
  sessionId: "reconcile",
};

async function allIssues(
  api: LinearApi,
  projectId: string,
  updatedAfter: string | undefined,
  includeArchived: boolean,
): Promise<Issue[]> {
  const issues: Issue[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api.issues(
      {
        projectId,
        ...(updatedAfter === undefined ? {} : { updatedAfter }),
        includeArchived,
      },
      after,
    );
    issues.push(...page.nodes);
    if (page.next === null) return issues;
    after = page.next;
  }
}

/** The cursor minus the overlap, as Linear's `updatedAfter` takes it. */
function pageStart(cursor: string | null): string | undefined {
  if (cursor === null) return undefined;
  const at = Date.parse(cursor);
  return Number.isNaN(at)
    ? cursor
    : new Date(at - CURSOR_OVERLAP_MS).toISOString();
}

/** The issue, or null when Linear no longer has it. */
async function readIssue(api: LinearApi, id: string): Promise<Issue | null> {
  try {
    return await api.issue(id);
  } catch (error) {
    if (isLinearError(error, "not_found")) return null;
    throw error;
  }
}

/**
 * When the claim was last spoken for: the newest of its claim comment and the
 * tool's report comments. Verdict comments and other tools' comments do not
 * count, so they never hide a person's reply.
 */
function replyBaseline(
  comments: readonly Comment[],
  workIds: ReadonlySet<string>,
): string {
  return comments
    .filter((comment) => {
      const claim = parseClaimComment(comment.body);
      if (claim !== null) return workIds.has(claim.workId);
      return isReportComment(comment.body);
    })
    .map((comment) => comment.createdAt)
    .reduce((latest, value) => (value > latest ? value : latest), "");
}

const REPORT_HEADING =
  /^\*\*(Done|Progress|Blocked|Released|Handoff)\*\*\s*$/mu;

/** The text of the newest report comment the tool wrote on an issue. */
export function latestReport(comments: readonly Comment[]): string | undefined {
  const reports = comments
    .filter((comment) => isToolComment(comment.body))
    .filter((comment) =>
      REPORT_HEADING.test(comment.body.split("\n")[0] ?? ""),
    );
  const done = reports.filter((comment) => comment.body.startsWith("**Done**"));
  const latest = (done.length > 0 ? done : reports).at(-1);
  if (latest === undefined) return undefined;
  const lines = latest.body.trimEnd().split("\n");
  return unescapeCommentText(lines.slice(1, -1).join("\n").trim()) || undefined;
}

/**
 * Abandons open work on an issue that is gone from the project: each row
 * becomes `abandoned` with attention `removed`, and its claim comment is
 * closed in Linear. Used by the reconciler and by a state move that finds
 * the issue gone when it re-reads it.
 */
export async function abandonWork(
  deps: LedgerDeps,
  project: ProjectRow,
  writer: Writer,
  works: readonly WorkRow[],
  identifier: string,
  why: string,
): Promise<void> {
  const { store } = deps;
  const now = deps.now().toISOString();
  for (const work of works) {
    const abandoned: WorkRow = {
      ...work,
      status: "abandoned",
      revision: work.revision + 1,
      updatedAt: now,
    };
    store.transaction(() => {
      store.putWork(abandoned);
      store.addEvent({
        projectKey: project.key,
        kind: "removed",
        issueId: work.issueId,
        identifier,
        workId: work.id,
        dedupe: `removed:${work.id}`,
        body: {
          reason: `${identifier} ${why}; work ${work.id} was abandoned`,
        },
      });
      endCompletions(store, work.id, `${identifier} ${why}`, now);
    });
    await closeClaim(deps, project, writer, abandoned, "abandoned");
  }
}

/**
 * What an issue's change since its cached copy means: a newly completed
 * issue without a passing done check queues a re-check (unless the tool's
 * own queued move brought it there), and one that left a completed state is
 * `reopened`. The reconciler runs it on every changed issue of its page; a
 * completion plan runs it (through observeIssue) on what it reads before
 * that read reaches the cache, so the reconciler never misses a change a
 * plan saw first.
 */
function noteChange(
  deps: LedgerDeps,
  project: ProjectRow,
  keys: ReadonlyMap<string, string>,
  before: Issue | undefined,
  issue: Issue,
  firstSync: boolean,
): void {
  const { store } = deps;
  const key = keys.get(issue.id) ?? issue.identifier;
  const wasDone = before?.stateType === "completed";
  const nowDone = issue.stateType === "completed";
  const openEvents = (kind: EventRow["kind"]) =>
    store
      .events(project.key, { kinds: [kind] })
      .filter((event) => event.issueId === issue.id);
  if (nowDone)
    for (const event of openEvents("reopened")) store.clearEvent(event.id);
  // The tool's own queued move arriving is not a person's action.
  const expected = openEvents("expected_move").filter(
    (event) => event.body["stateId"] === issue.stateId,
  );
  for (const event of expected) store.clearEvent(event.id);
  if (
    nowDone &&
    !wasDone &&
    expected.length === 0 &&
    !(firstSync && before === undefined)
  ) {
    // Someone else's completion: this machine's earlier entries belong to
    // an earlier one, unless its own open work's done report was held (a
    // person moving held work to done; the re-check says so).
    const ownOpen = store
      .workForIssue(project.key, issue.id)
      .some((work) => OPEN_WORK.has(work.status));
    if (!ownOpen)
      setVerdictFloor(
        store,
        project.key,
        issue.id,
        issue.identifier,
        "completed_elsewhere",
      );
    const outcome = currentDoneOutcome(store, project.key, issue.id, [
      key,
      issue.identifier,
    ]);
    if (outcome !== "verified")
      store.addEvent({
        projectKey: project.key,
        kind: "recheck",
        issueId: issue.id,
        identifier: issue.identifier,
        workId: null,
        dedupe: `recheck:${issue.id}:${issue.completedAt ?? issue.updatedAt}`,
        body: {
          reason: `${issue.identifier} was moved to ${issue.stateName} in Linear`,
        },
      });
  }
  if (wasDone && !nowDone) {
    for (const event of openEvents("recheck")) store.clearEvent(event.id);
    // The completion is gone: its verdict no longer speaks for the task.
    setVerdictFloor(
      store,
      project.key,
      issue.id,
      issue.identifier,
      "left_completed",
    );
    store.addEvent({
      projectKey: project.key,
      kind: "reopened",
      issueId: issue.id,
      identifier: issue.identifier,
      workId: null,
      dedupe: `reopened:${issue.id}:${issue.updatedAt}`,
      body: {
        reason: `${issue.identifier} left ${before?.stateName ?? "done"} for ${issue.stateName} in Linear after it was complete`,
      },
    });
  }
}

/**
 * Records an issue a completion plan read: the reconciler's detection runs
 * on it first (re-check, reopened, an expected move arriving), then it
 * reaches the cache. Plans never write the cache any other way, except for
 * the state their own move brought (ownArrival).
 */
export function observeIssue(
  deps: LedgerDeps,
  project: ProjectRow,
  issue: Issue,
): void {
  const { store } = deps;
  const before = store
    .cachedIssues(project.key)
    .find((entry) => entry.id === issue.id);
  if (before !== undefined && isDeepStrictEqual(before, issue)) return;
  noteChange(
    deps,
    project,
    keysOf(currentRevision(store, project)),
    before,
    issue,
    false,
  );
  store.cacheIssues(project.key, [issue]);
}

/**
 * The state a completion plan's own move brought the issue to: cached, and
 * a done re-check queued for it meanwhile is dropped (it was the tool's own
 * move, as with an expected-move marker).
 */
export function ownArrival(
  deps: LedgerDeps,
  project: ProjectRow,
  issue: Issue,
): void {
  const { store } = deps;
  store.cacheIssues(project.key, [issue]);
  for (const event of store.events(project.key, { kinds: ["recheck"] }))
    if (event.issueId === issue.id) store.clearEvent(event.id);
}

/**
 * Whether a pending completion plan of open local work owns an issue's
 * outcome: its re-check waits until the plan is done or abandoned.
 */
function ownedByPlan(deps: LedgerDeps, project: ProjectRow, issueId: string) {
  return deps.store.pendingCompletions(project.key).some((plan) => {
    if (plan.issueId !== issueId) return false;
    const work = deps.store.work(plan.workId);
    return work !== undefined && OPEN_WORK.has(work.status);
  });
}

/** The names of an issue's labels; re-reads the team's labels once on an unknown id. */
async function issueLabelNames(
  workspace: Workspace,
  issue: Issue,
): Promise<Set<string>> {
  const names = await workspace.labelNames(issue.labelIds);
  return new Set(
    issue.labelIds.flatMap((id) => {
      const name = names.get(id);
      return name === undefined ? [] : [name.toLowerCase()];
    }),
  );
}

const VERDICT_HEADING = /^\*\*vibecheck: .+\*\*\s*$/u;

/** Whether a tool verdict comment was posted after the issue's latest completion. */
function verdictSince(comments: readonly Comment[], issue: Issue): boolean {
  const since = issue.completedAt;
  if (since === null) return false;
  return comments.some(
    (comment) =>
      comment.createdAt >= since &&
      isToolComment(comment.body) &&
      VERDICT_HEADING.test(comment.body.split("\n")[0] ?? ""),
  );
}

/**
 * The verdict labels of changed issues, by the one verdict rule
 * (src/ledger/verdicts.ts). On an issue that is not complete, `vc:verified`
 * and `vc:unverified` are stale (a reopen, or a label older than the tool's
 * view of the issue) and are removed, and so is `vc:held` unless the issue
 * is claimed (the held work still open; its `vc:unverified` stays with it).
 * A verdict label the local entries do not explain (another machine judged
 * since) moves the issue's verdict floor, so the label speaks.
 */
async function settleVerdictLabels(
  deps: LedgerDeps,
  project: ProjectRow,
  writer: Writer,
  keys: ReadonlyMap<string, string>,
  changed: readonly { before: Issue | undefined; issue: Issue }[],
): Promise<void> {
  if (changed.length === 0) return;
  const { store } = deps;
  const workspace = workspaceFor(deps, project.teamId);
  for (const { before, issue } of changed) {
    const names = await issueLabelNames(workspace, issue);
    if (issue.stateType !== "completed") {
      if (!writesLabelsAndStates(project)) continue;
      const heldOpen = names.has("vc:held") && names.has("vc:claimed");
      const stale = [
        ...(names.has("vc:verified") ? ["vc:verified"] : []),
        ...(names.has("vc:unverified") && !heldOpen ? ["vc:unverified"] : []),
        ...(names.has("vc:held") && !heldOpen ? ["vc:held"] : []),
      ];
      for (const name of stale)
        await writer.removeNamedLabel(issue.id, workspace, name);
      continue;
    }
    if (
      before !== undefined &&
      isDeepStrictEqual(before.labelIds, issue.labelIds)
    )
      continue;
    const local = currentDoneOutcome(store, project.key, issue.id, [
      keys.get(issue.id) ?? issue.identifier,
      issue.identifier,
    ]);
    if (!labelsExplained(names, local))
      setVerdictFloor(
        store,
        project.key,
        issue.id,
        issue.identifier,
        "label_verdict",
      );
  }
}

/** Runs the reconciler for one project; a project without a Linear project is a no-op. */
export async function reconcile(
  deps: LedgerDeps,
  project: ProjectRow,
): Promise<ReconcileResult> {
  if (project.linearProjectId === "") return NONE;
  const { store } = deps;
  const api = deps.linear();
  const writer = new Writer(store, api, project.key);
  const now = deps.now().toISOString();
  const previous = new Map(
    store.cachedIssues(project.key).map((issue) => [issue.id, issue]),
  );
  const firstSync = project.syncedThrough === null;
  const since = pageStart(project.syncedThrough);
  const live = await allIssues(api, project.linearProjectId, since, false);
  const liveIds = new Set(live.map((issue) => issue.id));
  const archived = firstSync
    ? []
    : (await allIssues(api, project.linearProjectId, since, true)).filter(
        (issue) => !liveIds.has(issue.id),
      );
  const journal = currentRevision(store, project);
  const keys = keysOf(journal);
  const verdictLabelsChanged: { before: Issue | undefined; issue: Issue }[] =
    [];
  const openByIssue = new Map<string, WorkRow[]>();
  for (const work of store.openWork(project.key))
    if (OPEN_WORK.has(work.status))
      openByIssue.set(work.issueId, [
        ...(openByIssue.get(work.issueId) ?? []),
        work,
      ]);

  // Work on an issue that is gone: abandoned, its claim closed in Linear.
  const abandon = async (issueId: string, identifier: string, why: string) => {
    const works = openByIssue.get(issueId) ?? [];
    openByIssue.delete(issueId);
    await abandonWork(deps, project, writer, works, identifier, why);
  };

  for (const issue of archived) {
    store.uncacheIssue(project.key, issue.id);
    await abandon(
      issue.id,
      issue.identifier,
      "was archived or deleted in Linear",
    );
  }
  for (const issue of live) {
    const before = previous.get(issue.id);
    if (issue.projectId !== project.linearProjectId) {
      store.uncacheIssue(project.key, issue.id);
      await abandon(issue.id, issue.identifier, "left the project in Linear");
      continue;
    }
    // Seen exactly like this already (the page overlaps the cursor).
    if (before !== undefined && isDeepStrictEqual(before, issue)) continue;
    noteChange(deps, project, keys, before, issue, firstSync);
    verdictLabelsChanged.push({ before, issue });
  }
  store.cacheIssues(
    project.key,
    live.filter((issue) => issue.projectId === project.linearProjectId),
  );
  await settleVerdictLabels(deps, project, writer, keys, verdictLabelsChanged);
  const newest = live
    .map((issue) => issue.updatedAt)
    .reduce<string | null>(
      (latest, value) => (latest === null || value > latest ? value : latest),
      project.syncedThrough,
    );

  // Every open claim: is its issue still in the project? The page holds only
  // issues updated since the cursor, and one moved to another project is not
  // on it at all, so each claimed issue is read directly.
  for (const [issueId, works] of [...openByIssue]) {
    const listed = live.find((issue) => issue.id === issueId);
    if (listed !== undefined) continue;
    const fresh = await readIssue(api, issueId);
    const identifier = fresh?.identifier ?? works[0]?.identifier ?? issueId;
    if (fresh === null) {
      store.uncacheIssue(project.key, issueId);
      await abandon(issueId, identifier, "no longer exists in Linear");
    } else if (fresh.projectId !== project.linearProjectId) {
      store.uncacheIssue(project.key, issueId);
      await abandon(issueId, identifier, "left the project in Linear");
    } else store.cacheIssues(project.key, [fresh]);
  }

  // People's replies on claimed issues.
  for (const [issueId, works] of openByIssue) {
    let comments: readonly Comment[];
    try {
      comments = await api.comments(issueId);
    } catch (error) {
      if (!isLinearError(error, "not_found")) throw error;
      await abandon(
        issueId,
        works[0]?.identifier ?? issueId,
        "no longer exists in Linear",
      );
      continue;
    }
    // Claims cut off before their comment id was recorded: the comment in
    // Linear completes them, and with none the claim never landed.
    for (const work of works) {
      if (
        work.claimCommentId !== null ||
        Date.parse(now) - Date.parse(work.createdAt) < PENDING_CLAIM_MS
      )
        continue;
      const landed = comments.find((comment) => {
        const claim = parseClaimComment(comment.body);
        return claim?.workId === work.id && claim.status === "open";
      });
      store.putWork(
        landed === undefined
          ? {
              ...work,
              status: "released",
              revision: work.revision + 1,
              updatedAt: now,
            }
          : {
              ...work,
              claimCommentId: landed.id,
              revision: work.revision + 1,
              updatedAt: now,
            },
      );
    }
    // Claims closed (or deleted) in Linear by someone else: the work here
    // stops. A status this machine recorded it is writing itself (a pending
    // completion plan's) is its own close, never a lost claim.
    const kept: WorkRow[] = [];
    for (const work of works) {
      const current = store.work(work.id) ?? work;
      if (!OPEN_WORK.has(current.status)) continue;
      const lost = lostClaim(
        current,
        comments,
        ownClosingStatuses(store, work.id),
      );
      if (lost === undefined) {
        kept.push(current);
        continue;
      }
      markClaimLost(store, project, current, lost, now);
    }
    if (kept.length === 0) continue;
    const baseline = replyBaseline(
      comments,
      new Set(kept.map((work) => work.id)),
    );
    for (const comment of comments) {
      if (
        isToolComment(comment.body) ||
        comment.userId === null ||
        comment.createdAt <= baseline
      )
        continue;
      const work = kept[0];
      const text = comment.body.replace(/\s+/gu, " ").trim();
      store.addEvent({
        projectKey: project.key,
        kind: "human_reply",
        issueId,
        identifier: work?.identifier ?? issueId,
        workId: work?.id ?? null,
        dedupe: `reply:${comment.id}`,
        body: {
          reason: `reply on ${work?.identifier ?? issueId}: ${text.length > REPLY_LIMIT ? `${text.slice(0, REPLY_LIMIT)}...` : text}`,
          commentId: comment.id,
          createdAt: comment.createdAt,
        },
      });
    }
  }

  // Refresh the policy the hooks read, and the project's name and URL.
  let policy = project.policy;
  const linearProject = await api.project(project.linearProjectId);
  if (project.policyDocumentId !== null) {
    const document = (await api.documents(project.linearProjectId)).find(
      (entry) => entry.id === project.policyDocumentId,
    );
    if (document !== undefined)
      policy = { ...parsePolicyDocument(document.content) };
  } else if (linearProject !== null && project.adoption !== "created") {
    const parsed = parsePolicyDocument(linearProject.content);
    policy =
      parsed.goal === undefined && parsed.rules === undefined
        ? null
        : { ...parsed };
  }
  const updated: ProjectRow = {
    ...project,
    syncedThrough: newest,
    policy,
    ...(linearProject === null
      ? {}
      : { url: linearProject.url, name: linearProject.name }),
    updatedAt: now,
  };
  store.putProject(updated);

  const rechecked = await runRechecks(deps, updated, writer);
  return {
    changed: live.length + archived.length,
    rechecked,
    waiting: store.events(project.key, { kinds: ["recheck"] }).length,
    queued: writer.queued,
  };
}

/**
 * Runs queued done re-checks, at most `maxRechecks`. An event is cleared only
 * after its re-check is recorded and its writes are sent or queued, so a
 * failure part-way leaves it for the next run.
 */
async function runRechecks(
  deps: LedgerDeps,
  project: ProjectRow,
  writer: Writer,
): Promise<number> {
  const { store } = deps;
  const api = deps.linear();
  const limit = deps.config.reconcile?.maxRechecks ?? DEFAULT_MAX_RECHECKS;
  const queuedChecks = store.events(project.key, { kinds: ["recheck"] });
  if (queuedChecks.length === 0 || limit <= 0) return 0;
  const workspace = workspaceFor(deps, project.teamId);
  const access = store.verificationAccess();
  const keys = keysOf(currentRevision(store, project));
  const cached = new Map(
    store.cachedIssues(project.key).map((issue) => [issue.id, issue]),
  );
  const labelNames = await workspace.labelNames(
    [...cached.values()].flatMap((issue) => issue.labelIds),
  );
  const { resolved } = await workspace.states();
  const snapshot = buildSnapshot({
    project,
    issues: store.cachedIssues(project.key),
    journal: currentRevision(store, project),
    labelNames,
    reviewStateId: resolved.review?.id ?? null,
    openWork: store.openWork(project.key),
  });
  let rechecked = 0;
  for (const event of queuedChecks.slice(0, limit)) {
    // A pending completion plan owns this issue's outcome: the re-check
    // waits (still queued) until the plan is done or abandoned.
    if (ownedByPlan(deps, project, event.issueId)) continue;
    const issue =
      cached.get(event.issueId) ?? (await readIssue(api, event.issueId));
    if (issue === null || issue.stateType !== "completed") {
      store.clearEvent(event.id);
      continue;
    }
    const task = taskView(
      issue,
      keys.get(issue.id) ?? issue.identifier,
      labelNames,
      resolved.review?.id ?? null,
    );
    let comments: readonly Comment[];
    try {
      comments = await api.comments(issue.id);
    } catch (error) {
      if (!isLinearError(error, "not_found")) throw error;
      store.clearEvent(event.id);
      continue;
    }
    const report = latestReport(comments);
    // Open work of this machine whose latest done run held the task: a
    // person moving the issue to done does not make the held report true.
    const heldWork = store
      .workForIssue(project.key, issue.id)
      .find((work) => OPEN_WORK.has(work.status));
    const heldHere =
      heldWork !== undefined &&
      latestDoneOutcome(access, project.key, [task.key, issue.identifier]) ===
        "held";
    // Verdicts are shared through Linear: the tool's labels and verdict
    // comments say whether any machine judged this completion already.
    const names = await issueLabelNames(workspace, issue);
    const heldInLinear = names.has("vc:held");
    if (!heldHere) {
      const judged =
        names.has("vc:verified") ||
        names.has("vc:unverified") ||
        (!heldInLinear && verdictSince(comments, issue));
      if (judged) {
        store.clearEvent(event.id);
        continue;
      }
    }
    const held = heldHere || heldInLinear;
    const heldBy =
      heldHere && heldWork !== undefined
        ? `work ${heldWork.id} of this machine held its done report`
        : "it carries vc:held (a done report on it was held)";
    const pending: PendingEntry[] = held
      ? [
          {
            subject: { projectId: project.key, taskId: task.key },
            entry: deterministicEntry(
              "vibecheck.claims-done",
              null,
              { block: false, review: true },
              {
                source: "ledger:reconcile",
                evidence: { kind: "linear", ref: `issue:${task.identifier}` },
                reportedStatus: "complete",
                appliedStatus: "complete",
                outcome: "review",
                reason: `${task.identifier} was moved to ${task.stateName} in Linear while ${heldBy}, so it is not verified`,
              },
            ),
          },
        ]
      : deps.verifier === undefined
        ? [
            {
              subject: { projectId: project.key, taskId: task.key },
              entry: deterministicEntry(
                "vibecheck.claims-done",
                null,
                { block: false, review: true },
                {
                  source: "ledger:reconcile",
                  evidence: {
                    kind: "linear",
                    ref: `issue:${task.identifier}`,
                  },
                  reportedStatus: "complete",
                  appliedStatus: "complete",
                  outcome: "review",
                  reason: `${task.identifier} was moved to ${task.stateName} in Linear; the ledger checks are off, so it was not read`,
                },
              ),
            },
          ]
        : await deps.verifier.recheckDone(snapshot, task, report);
    // As-is projects: an issue no agent of this tool claimed is the
    // people's own; its result stays in local history and attention. A
    // machine whose checks are off (or whose judgment source is unusable)
    // writes nothing for a re-check either: its entry stays local.
    const claimed =
      store.workForIssue(project.key, issue.id).length > 0 ||
      comments.some((comment) => parseClaimComment(comment.body) !== null);
    const writes =
      deps.verifier !== undefined &&
      writesLabelsAndStates(project) &&
      (project.adoption !== "as_is" || claimed);
    const items = store.transaction(() => recordEntries(access, pending));
    rechecked += 1;
    // Verified only when every done check of the run passed, claims-done
    // and done-admits-unfinished among them, and nothing holds the task.
    const verified = !held && doneItemsVerified(items);
    if (held)
      store.addEvent({
        projectKey: project.key,
        kind: "held_done_moved",
        issueId: issue.id,
        identifier: issue.identifier,
        workId: heldHere && heldWork !== undefined ? heldWork.id : null,
        dedupe: `held_done_moved:${issue.id}:${issue.completedAt ?? issue.updatedAt}`,
        body: {
          reason: `${issue.identifier} was moved to ${issue.stateName} in Linear while ${heldBy}; it is marked vc:unverified${heldHere && heldWork !== undefined ? `, and work ${heldWork.id} stays open until it reports done again or is released` : ""}`,
        },
      });
    if (writes) {
      // Removal never trusts the cache: removing an absent label is a no-op.
      const remove = async (
        name: "vc:held" | "vc:unverified" | "vc:verified",
      ) => {
        await writer.removeNamedLabel(issue.id, workspace, name);
      };
      const add = async (name: "vc:unverified" | "vc:verified") => {
        await writer.addOwnLabel(issue.id, workspace, name, vcLabelColor(name));
      };
      if (held) {
        // A held task: a re-check only adds vc:unverified; it never adds
        // vc:verified or takes vc:held off.
        await add("vc:unverified");
      } else if (verified) {
        await add("vc:verified");
        await remove("vc:unverified");
        await remove("vc:held");
      } else {
        await add("vc:unverified");
        await remove("vc:verified");
      }
      for (const [index, item] of items.entries())
        if (
          item.outcome === "failed" ||
          item.outcome === "review" ||
          item.outcome === "flagged"
        )
          await writer.comment(
            issue.id,
            renderVerdictComment(
              RECONCILER,
              item.check,
              item.outcome,
              item.reason,
            ),
            stableId("recheck", String(event.id), String(index), item.check),
          );
    }
    store.clearEvent(event.id);
  }
  return rechecked;
}
