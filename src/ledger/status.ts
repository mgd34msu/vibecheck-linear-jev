// project_status, work_history and project_update.
//
// Status reconciles with Linear first, then reads the local cache: every task
// with its reported status (from its Linear state and the tool's labels) and
// its verified status (from the latest done check), the open work, the
// sessions, and the attention list, led by `next`: what the calling session
// should do now (src/ledger/next.ts). When Linear cannot be reached it answers
// from the cache and says so in `sync`. project_update posts a Linear project
// update whose body, when the caller gives none, is drafted from verified
// status.

import { BoardError } from "../errors.js";
import { isLinearError } from "../linear/errors.js";
import type { CompletionRow, ProjectRow } from "../local/types.js";
import type {
  ProjectStatusRequest,
  ProjectUpdateRequest,
  WorkHistory,
} from "../schemas.js";
import { isToolComment } from "../linear/states.js";
import { queryEntries } from "../verification/store.js";
import {
  labelVerdict,
  verificationView,
  type AttentionItem,
  type StatusTask,
} from "../verification/status.js";
import {
  OPEN_WORK,
  currentRevision,
  projectKeyOf,
  requireAdopted,
  requireLinked,
  requireProject,
  requireSession,
  sessionIdOf,
  touchSession,
  workResult,
} from "./access.js";
import {
  stableId,
  workspaceFor,
  Writer,
  alreadyExists,
  type LedgerDeps,
} from "./context.js";
import { eventAttention } from "./attention.js";
import { nextCandidates, nextSteps, type Blockers } from "./next.js";
import { refreshPlanMap } from "./plan.js";
import { MAX_COMPLETION_ATTEMPTS } from "./completion.js";
import { reconcile } from "./reconcile.js";
import { verdictFloors } from "./verdicts.js";
import {
  buildSnapshot,
  findTask,
  type Snapshot,
  type TaskView,
} from "./snapshot.js";

/** What `sync` reports in a result. */
export interface SyncInfo {
  readonly pending: number;
  /** Done re-checks still queued: over the per-run limit, or one that failed part-way. */
  readonly pending_rechecks?: number;
  /** Completions, releases and handoffs recorded and not finished in Linear. */
  readonly pending_completions?: number;
  readonly error?: string;
}

/** Candidates whose Linear relations `next` reads at most, per call. */
const BLOCKER_LOOKUPS = 20;

/**
 * Linear `blocks` relations of `next`'s candidates, best first, until one
 * has no unfinished blocker (that one is offered). A blocker outside the
 * project's tasks is read from Linear; a blocker that cannot be read is not
 * known to be finished. When Linear stops answering the lookups stop, and
 * the candidates not read are offered as before.
 */
async function candidateBlockers(
  deps: LedgerDeps,
  tasks: readonly TaskView[],
  candidates: readonly TaskView[],
): Promise<Map<string, Blockers>> {
  const found = new Map<string, Blockers>();
  const byId = new Map(tasks.map((task) => [task.issueId, task]));
  const api = deps.linear();
  try {
    for (const candidate of candidates.slice(0, BLOCKER_LOOKUPS)) {
      const unfinished: string[] = [];
      const cancelled: string[] = [];
      for (const relation of await api.relations(candidate.issueId)) {
        if (
          relation.type !== "blocks" ||
          relation.relatedIssueId !== candidate.issueId
        )
          continue;
        const known = byId.get(relation.issueId);
        const blocker =
          known === undefined
            ? await api.issue(relation.issueId).catch((error: unknown) => {
                if (isLinearError(error, "not_found")) return null;
                throw error;
              })
            : null;
        const identifier =
          known?.key ?? blocker?.identifier ?? relation.issueId;
        const state =
          known === undefined
            ? blocker === null
              ? undefined
              : blocker.stateType === "completed"
                ? "complete"
                : blocker.stateType === "canceled"
                  ? "cancelled"
                  : "open"
            : known.status;
        if (state === "cancelled") cancelled.push(identifier);
        else if (state !== "complete") unfinished.push(identifier);
      }
      found.set(candidate.issueId, { unfinished, cancelled });
      if (unfinished.length === 0) break;
    }
  } catch (error) {
    if (
      !isLinearError(error) &&
      !(error instanceof BoardError && error.code === "unavailable")
    )
      throw error;
  }
  return found;
}

/** Done re-checks still queued for a project. */
export function pendingRechecks(deps: LedgerDeps, project: ProjectRow): number {
  return deps.store.events(project.key, { kinds: ["recheck"] }).length;
}

async function freshSnapshot(
  deps: LedgerDeps,
  project: ProjectRow,
): Promise<{ project: ProjectRow; snapshot: Snapshot; sync: SyncInfo }> {
  let current = project;
  let error: string | undefined;
  let labelNames = new Map<string, string>();
  let reviewStateId: string | null = null;
  if (project.linearProjectId !== "" && project.adoption !== "pending") {
    try {
      await reconcile(deps, project);
      current = await refreshPlanMap(
        deps,
        requireProject(deps.store, project.key),
      );
      const workspace = workspaceFor(deps, project.teamId);
      labelNames = await workspace.labelNames(
        deps.store.cachedIssues(current.key).flatMap((issue) => issue.labelIds),
      );
      reviewStateId = (await workspace.states()).resolved.review?.id ?? null;
    } catch (failure) {
      if (
        !isLinearError(failure, "network", "server", "rate_limited", "auth") &&
        !(failure instanceof BoardError && failure.code === "unavailable")
      )
        throw failure;
      error = `served from the local cache: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
  }
  const waiting = pendingRechecks(deps, current);
  const completions = deps.store.pendingCompletions(current.key).length;
  const snapshot = buildSnapshot({
    project: current,
    issues: deps.store.cachedIssues(current.key),
    journal: currentRevision(deps.store, current),
    labelNames,
    reviewStateId,
    openWork: deps.store.openWork(current.key),
  });
  return {
    project: current,
    snapshot,
    sync: {
      pending: deps.store.pendingCount(),
      ...(waiting === 0 ? {} : { pending_rechecks: waiting }),
      ...(completions === 0 ? {} : { pending_completions: completions }),
      ...(error === undefined ? {} : { error }),
    },
  };
}

function statusTasks(
  snapshot: Snapshot,
  plans: readonly CompletionRow[],
  floors: ReadonlyMap<string, number>,
): Map<string, StatusTask> {
  const planned = new Set(plans.map((plan) => plan.issueId));
  const completions = new Set(
    plans
      .filter((plan) => plan.kind === "complete" && plan.decision !== "held")
      .map((plan) => plan.issueId),
  );
  return new Map(
    snapshot.tasks.map((task) => {
      // While this machine's own completion plan of the issue is pending,
      // its labels are mid-change: the local entries speak for it.
      const completing = completions.has(task.issueId);
      const linearVerdict = planned.has(task.issueId)
        ? undefined
        : labelVerdict(task.labels);
      const floor = floors.get(task.issueId);
      return [
        task.key,
        {
          key: task.key,
          identifier: task.identifier,
          status: task.status,
          hasStandard: task.hasStandard,
          updatedAt: task.updatedAt,
          completedAt: task.completedAt,
          ...(linearVerdict === undefined ? {} : { linearVerdict }),
          ...(floor === undefined ? {} : { floor }),
          ...(completing ? { completing } : {}),
        },
      ];
    }),
  );
}

function projectSummary(project: ProjectRow) {
  return {
    key: project.key,
    linear_project_id:
      project.linearProjectId === "" ? null : project.linearProjectId,
    url: project.url,
    name: project.name,
    adoption: project.adoption,
  };
}

/** Status of a project; `compact` limits tasks to open ones and those needing attention. */
export async function projectStatus(
  deps: LedgerDeps,
  request: ProjectStatusRequest,
) {
  const initial = requireProject(deps.store, projectKeyOf(request.project_id));
  const caller =
    request.session_id == null
      ? undefined
      : requireSession(deps.store, initial, sessionIdOf(request.session_id));
  const { project, snapshot, sync } = await freshSnapshot(deps, initial);
  const access = deps.store.verificationAccess();
  const view = verificationView(access, {
    projectKey: project.key,
    tasks: statusTasks(
      snapshot,
      deps.store.pendingCompletions(project.key),
      verdictFloors(deps.store, project.key),
    ),
    openWork: snapshot.openWork,
    events: deps.store.events(project.key, {
      kinds: [
        "reopened",
        "removed",
        "human_reply",
        "skipped_move",
        "held_done_moved",
        "write_dropped",
      ],
    }),
  });
  // Claims another machine or a person closed: the agent must stop first.
  const keyByIssue = new Map(
    snapshot.tasks.map((task) => [task.issueId, task.key]),
  );
  const lost = deps.store
    .events(project.key, { kinds: ["claim_lost"] })
    .map((event) => {
      const { identifier: _identifier, ...item } = eventAttention(
        event,
        keyByIssue.get(event.issueId) ?? event.identifier,
      );
      return { ...item, check: "linear" };
    });
  // Completion plans Linear rejected MAX_COMPLETION_ATTEMPTS times: they
  // resume only when their request is repeated.
  const waiting = deps.store
    .pendingCompletions(project.key)
    .filter((plan) => plan.attempts >= MAX_COMPLETION_ATTEMPTS)
    .map((plan) => ({
      kind: "completion_waiting",
      reason: `the ${plan.kind === "complete" ? "completion" : plan.kind} of work ${plan.workId} on ${plan.identifier} stopped after Linear rejected it ${plan.attempts} times (${plan.done} of ${plan.steps.length} steps done; last error: ${plan.reason ?? "unknown"}); repeat work_update with request_id ${plan.requestId} and the same change to resume it`,
      entry_id: `completion:${plan.id}`,
      at: plan.updatedAt,
      task_id: keyByIssue.get(plan.issueId) ?? plan.identifier,
      work_id: plan.workId,
      request_id: plan.requestId,
      last_error: plan.reason ?? "unknown",
      check: "linear",
    }));
  const attention = [...lost, ...waiting, ...view.attention];
  const owners = new Map(
    snapshot.openWork
      .filter((work) => OPEN_WORK.has(work.status))
      .map((work) => [work.issueId, work.id]),
  );
  const attentionKeys = new Set(
    attention.flatMap((item: Pick<AttentionItem, "task_id">) =>
      item.task_id === undefined ? [] : [item.task_id],
    ),
  );
  const wanted = new Set<string>(request.task_ids ?? []);
  const selected = snapshot.tasks.filter((task) => {
    if (wanted.size > 0)
      return wanted.has(task.key) || wanted.has(task.identifier);
    if (request.full === true) return true;
    return (
      (task.status !== "complete" && task.status !== "cancelled") ||
      attentionKeys.has(task.key)
    );
  });
  const counts: Record<string, number> = {};
  for (const task of snapshot.tasks)
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  const tasks = Object.fromEntries(
    selected.map((task: TaskView) => {
      const verified = view.tasks.get(task.key);
      const owner = owners.get(task.issueId);
      return [
        task.key,
        {
          identifier: task.identifier,
          title: task.title,
          status: task.status,
          state: task.stateName,
          url: task.url,
          ...(owner === undefined ? {} : { owner_work_id: owner }),
          ...(verified === undefined
            ? {}
            : {
                verified: verified.verified,
                verified_reason: verified.reason,
              }),
          ...(task.hasStandard ? {} : { missing_standard: true }),
        },
      ];
    }),
  );
  const journal = currentRevision(deps.store, project);
  const includeMap = request.include_map === true || request.full === true;
  const blockers =
    sync.error === undefined
      ? await candidateBlockers(
          deps,
          snapshot.tasks,
          nextCandidates({
            openWork: snapshot.openWork,
            tasks: snapshot.tasks,
            journal,
          }),
        )
      : undefined;
  const next = nextSteps({
    sessionId: caller?.id,
    attention,
    sessionWork:
      caller === undefined ? [] : deps.store.workForSession(caller.id),
    openWork: snapshot.openWork,
    tasks: snapshot.tasks,
    journal,
    verified: new Map(
      [...view.tasks].map(([key, entry]) => [key, entry.verified]),
    ),
    ...(blockers === undefined ? {} : { blockers }),
  });
  return {
    next,
    project_id: project.key,
    plan_revision: project.planRevision,
    project: projectSummary(project),
    ...(attention.length === 0 ? {} : { attention }),
    tasks,
    counts,
    work: snapshot.openWork
      .filter((work) => OPEN_WORK.has(work.status))
      .map((work) =>
        workResult(
          work,
          snapshot.tasks.find((task) => task.issueId === work.issueId)?.key ??
            work.identifier,
        ),
      ),
    sessions: deps.store.sessions(project.key).map((session) => ({
      id: session.id,
      vendor: session.vendor,
      runtime: session.runtime,
      model: session.model,
      parent_session_id: session.parentSessionId,
      coordinator: project.coordinatorSessionId === session.id,
      acknowledged_plan_revision: session.acknowledgedPlanRevision,
      last_seen_at: session.lastSeenAt,
    })),
    ...(request.full === true && view.tasks.size > 0
      ? { verification: Object.fromEntries(view.tasks) }
      : {}),
    ...(request.known_plan_revision != null &&
    request.known_plan_revision < project.planRevision
      ? { plan_changed: true }
      : {}),
    ...(includeMap
      ? {
          task_map: Object.fromEntries(
            (journal?.tasks ?? []).map((task) => [
              task.key,
              { ...task.definition, identifier: task.identifier },
            ]),
          ),
        }
      : {}),
    sync,
  };
}

const COMMENT_LIMIT = 2000;

export async function workHistory(deps: LedgerDeps, request: WorkHistory) {
  const { store } = deps;
  const project = requireProject(store, projectKeyOf(request.project_id));
  const all = store.allWork(project.key);
  const journal = currentRevision(store, project);
  const cached = store.cachedIssues(project.key);
  let issueId: string | undefined;
  let taskKey: string | undefined;
  if (request.task_id != null) {
    const snapshot = buildSnapshot({
      project,
      issues: cached,
      journal,
      labelNames: new Map(),
      reviewStateId: null,
      openWork: [],
    });
    const task = findTask(snapshot, request.task_id);
    const mapped = journal?.tasks.find(
      (entry) => entry.key === request.task_id,
    );
    issueId = task?.issueId ?? mapped?.issueId;
    taskKey = task?.key ?? mapped?.key ?? request.task_id;
    if (issueId === undefined) {
      const found = all.find(
        (work) =>
          work.identifier.toUpperCase() === request.task_id?.toUpperCase(),
      );
      issueId = found?.issueId;
    }
  }
  const limit = request.limit ?? 100;
  const work = all
    .filter((entry) => issueId === undefined || entry.issueId === issueId)
    .filter(() => request.task_id == null || issueId !== undefined)
    .filter(
      (entry) =>
        request.session_id == null ||
        String(entry.sessionId) === String(request.session_id),
    )
    .filter(
      (entry) =>
        request.path == null ||
        entry.location.paths.some(
          (path) =>
            path === request.path ||
            path.startsWith(`${request.path}/`) ||
            (request.path ?? "").startsWith(`${path}/`),
        ),
    )
    .filter(
      (entry) =>
        request.branch == null || entry.location.branch === request.branch,
    )
    .filter(
      (entry) =>
        request.commit == null ||
        entry.commit === request.commit ||
        entry.integrationCommit === request.commit,
    )
    .slice(-limit);
  const keyFor = (id: string) =>
    journal?.tasks.find((entry) => entry.issueId === id)?.key ??
    cached.find((issue) => issue.id === id)?.identifier ??
    all.find((entry) => entry.issueId === id)?.identifier ??
    id;
  let comments:
    | {
        id: string;
        created_at: string;
        kind: "tool" | "person";
        body: string;
      }[]
    | undefined;
  let commentsError: string | undefined;
  if (issueId !== undefined) {
    try {
      comments = (await deps.linear().comments(issueId)).map((comment) => ({
        id: comment.id,
        created_at: comment.createdAt,
        kind: isToolComment(comment.body) ? "tool" : "person",
        body:
          comment.body.length > COMMENT_LIMIT
            ? `${comment.body.slice(0, COMMENT_LIMIT)}...`
            : comment.body,
      }));
    } catch (error) {
      if (!isLinearError(error) && !(error instanceof BoardError)) throw error;
      commentsError = error instanceof Error ? error.message : String(error);
    }
  }
  const identifiers = new Set(work.map((entry) => entry.identifier));
  const taskIds = [
    ...(taskKey === undefined ? [] : [taskKey]),
    ...identifiers,
    ...work.map((entry) => keyFor(entry.issueId)),
  ];
  const access = store.verificationAccess();
  const workIds = work.map((entry) => entry.id);
  const entries =
    request.task_id != null
      ? queryEntries(access, {
          projectId: project.key,
          taskIds: [...new Set(taskIds)],
          workIds,
          limit: 500,
        })
      : workIds.length > 0
        ? queryEntries(access, { projectId: project.key, workIds, limit: 500 })
        : request.session_id != null
          ? queryEntries(access, {
              projectId: project.key,
              sessionId: request.session_id,
              limit: 500,
            })
          : [];
  const verifications = entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    created_at: entry.created_at,
    task_id: entry.task_id,
    work_id: entry.work_id,
    session_id: entry.session_id,
    ...(entry.kind === "verdict"
      ? {
          check: entry.body.battery_id,
          version: entry.body.battery_version,
          outcome: entry.body.outcome,
          reason: entry.body.reason,
          source: entry.body.source,
          judged_by: entry.body.judged_by,
          readings: entry.body.readings,
        }
      : entry.kind === "unavailable"
        ? {
            check: entry.body.battery_id,
            error: entry.body.error,
            source: entry.body.source,
          }
        : entry.kind === "report"
          ? {
              action: entry.body.action,
              status: entry.body.status,
              report: entry.body.report,
            }
          : {
              verdict_id: entry.body.verdict_id,
              right: entry.body.right,
              note: entry.body.note,
            }),
  }));
  return {
    project_id: project.key,
    work: work.map((entry) => workResult(entry, keyFor(entry.issueId))),
    ...(comments === undefined ? {} : { comments }),
    ...(commentsError === undefined ? {} : { comments_error: commentsError }),
    verifications,
  };
}

/** A project update body drafted from verified status. */
export function draftUpdate(
  status: Awaited<ReturnType<typeof projectStatus>>,
  today: string,
): string {
  const lines = [`Verified status on ${today} (vibecheck).`, ""];
  const total = Object.values(status.counts).reduce(
    (sum, value) => sum + value,
    0,
  );
  const complete = status.counts["complete"] ?? 0;
  // Only tasks complete now and verified now: a verdict of an earlier
  // completion never counts for a reopened task.
  const verified = Object.entries(status.verification ?? {}).filter(
    ([key, entry]) =>
      entry.verified === "verified" && status.tasks[key]?.status === "complete",
  ).length;
  lines.push(
    `* ${complete} of ${total} tasks complete; ${verified} verified by their done checks.`,
  );
  const byStatus = (wanted: string) =>
    Object.entries(status.tasks)
      .filter(([, task]) => task.status === wanted)
      .map(([key, task]) =>
        key === task.identifier ? key : `${key} (${task.identifier})`,
      );
  const inProgress = byStatus("in_progress");
  const blocked = byStatus("blocked");
  if (inProgress.length > 0)
    lines.push(`* In progress: ${inProgress.join(", ")}.`);
  if (blocked.length > 0) lines.push(`* Blocked: ${blocked.join(", ")}.`);
  const attention = (status.attention ?? []).slice(0, 5);
  if (attention.length > 0) {
    lines.push("", "Needs attention:");
    for (const item of attention)
      lines.push(
        `* ${item.kind}${item.task_id === undefined ? "" : ` ${item.task_id}`}: ${item.reason}`,
      );
  }
  return lines.join("\n");
}

export async function projectUpdate(
  deps: LedgerDeps,
  request: ProjectUpdateRequest,
) {
  const { store } = deps;
  const project = requireProject(store, projectKeyOf(request.project_id));
  const session = requireSession(
    store,
    project,
    sessionIdOf(request.session_id),
  );
  requireAdopted(project);
  if (project.adoption === "as_is")
    throw new BoardError(
      "forbidden",
      `Project ${project.key} is used as_is: vibecheck posts no project updates there.`,
      { mode: "as_is" },
    );
  const projectId = requireLinked(project);
  const status = await projectStatus(deps, {
    project_id: request.project_id,
    full: true,
  });
  const held = (status.attention ?? []).some(
    (item) =>
      item.kind === "held_done" ||
      ("urgency" in item && item.urgency === "high") ||
      ("needs" in item && item.needs === "user"),
  );
  const health = request.health ?? (held ? "atRisk" : "onTrack");
  const body =
    request.body ?? draftUpdate(status, deps.now().toISOString().slice(0, 10));
  const id = stableId(projectId, "update", request.request_id);
  const api = deps.linear();
  const writer = new Writer(store, api, project.key);
  let posted = false;
  try {
    await api.createProjectUpdate({ id, projectId, body, health });
    posted = true;
  } catch (error) {
    if (alreadyExists(error)) posted = true;
    else if (isLinearError(error, "network", "server", "rate_limited"))
      await writer.projectUpdate({ id, projectId, body, health });
    else throw error;
  }
  touchSession(store, session, deps.now().toISOString());
  return {
    update: { id, health, body, posted },
    sync: { pending: store.pendingCount() },
  };
}
