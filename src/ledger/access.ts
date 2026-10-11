// Lookups and checks every ledger tool repeats: the project row, the session
// and whether it may act, the current plan revision, the tool's own labels,
// and the snake_case shapes tool results use for work and issues.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BoardError } from "../errors.js";
import type { Issue } from "../linear/api.js";
import { VC_LABELS, type VcLabelName } from "../linear/states.js";
import type {
  JournalRevision,
  LocalStore,
  ProjectKey,
  ProjectRow,
  SessionId,
  SessionRow,
  WorkId,
  WorkRow,
  WorkStatus,
} from "../local/types.js";
import type { Location } from "../schemas.js";

/**
 * As-is mode may add the tool's `vc:*` and `agent:*` labels to issues agents
 * claim and move the states of those issues.
 * Set to false to limit as-is writes to comments.
 */
export const AS_IS_WRITES_LABELS_AND_STATES = true;

/**
 * Managed mode keeps the titles of issues that existed before adoption, so
 * those issues use their identifiers as task keys. Set to true to prefix
 * their titles with the plan key, as tool-created issues are.
 */
export const MANAGED_PREFIXES_EXISTING_TITLES = false;

/** Work in these statuses still holds its issue. */
export const OPEN_WORK: ReadonlySet<WorkStatus> = new Set([
  "in_progress",
  "blocked",
  "awaiting_integration",
]);

const projectKeySchema = z.custom<ProjectKey>(
  (value) => typeof value === "string" && value !== "",
);
const sessionIdSchema = z.custom<SessionId>(
  (value) => typeof value === "string" && value !== "",
);
const workIdSchema = z.custom<WorkId>(
  (value) => typeof value === "string" && value !== "",
);

export function newSessionId(): SessionId {
  return sessionIdSchema.parse(`s_${randomUUID().replaceAll("-", "")}`);
}

export function newWorkId(): WorkId {
  return workIdSchema.parse(`w_${randomUUID().replaceAll("-", "")}`);
}

/** A request's project id as a store key. */
export function projectKeyOf(value: string): ProjectKey {
  return projectKeySchema.parse(value);
}

/** A request's session id as a store id. */
export function sessionIdOf(value: string): SessionId {
  return sessionIdSchema.parse(value);
}

/** A request's work id as a store id. */
export function workIdOf(value: string): WorkId {
  return workIdSchema.parse(value);
}

export function requireProject(store: LocalStore, key: ProjectKey): ProjectRow {
  const project = store.project(key);
  if (project === undefined)
    throw new BoardError(
      "not_found",
      `Project ${key} is unknown on this machine; call project_join first.`,
    );
  return project;
}

/** The session, which must belong to the project. */
export function requireSession(
  store: LocalStore,
  project: ProjectRow,
  id: SessionId,
): SessionRow {
  const session = store.session(id);
  if (session === undefined)
    throw new BoardError("not_found", `Session ${id} does not exist.`);
  if (session.projectKey !== project.key)
    throw new BoardError(
      "forbidden",
      `Session ${id} belongs to project ${session.projectKey}, not ${project.key}.`,
    );
  return session;
}

export function requireCoordinator(
  project: ProjectRow,
  session: SessionRow,
): void {
  if (project.coordinatorSessionId !== session.id)
    throw new BoardError(
      "forbidden",
      "Only the coordinator can change the plan.",
    );
}

/** The project's Linear id; a conflict when no Linear project is linked yet. */
export function requireLinked(project: ProjectRow): string {
  if (project.linearProjectId === "")
    throw new BoardError(
      "conflict",
      `Project ${project.key} has no Linear project yet; the coordinator creates it with plan_publish.`,
    );
  return project.linearProjectId;
}

/** Refuses a write the project's adoption mode does not allow. */
export function requireAdopted(project: ProjectRow): void {
  if (project.adoption === "pending")
    throw new BoardError(
      "forbidden",
      `Project ${project.key} uses an existing Linear project and the user has not chosen how vibecheck may treat it; ask the user, then call project_join with adopt "as_is" or "managed".`,
    );
}

export function currentRevision(
  store: LocalStore,
  project: ProjectRow,
): JournalRevision | undefined {
  return project.planRevision === 0
    ? undefined
    : store.revision(project.key, project.planRevision);
}

/** Records that a session acted now. */
export function touchSession(
  store: LocalStore,
  session: SessionRow,
  now: string,
): SessionRow {
  const updated = { ...session, lastSeenAt: now };
  store.putSession(updated);
  return updated;
}

/** The color of one of the tool's own labels. */
export function vcLabelColor(name: VcLabelName): string {
  return VC_LABELS.find((label) => label.name === name)?.color ?? "#5e6ad2";
}

/** Whether the project's mode lets the tool add its labels and move states. */
export function writesLabelsAndStates(project: ProjectRow): boolean {
  return project.adoption !== "as_is" || AS_IS_WRITES_LABELS_AND_STATES;
}

export function locationRecord(
  location: Location | undefined,
): WorkRow["location"] {
  return {
    repository: location?.repository ?? null,
    checkout: location?.checkout ?? null,
    branch: location?.branch ?? null,
    targetBranch: location?.target_branch ?? null,
    baseCommit: location?.base_commit ?? null,
    paths: [...(location?.paths ?? [])],
  };
}

export function mergeLocation(
  old: WorkRow["location"],
  patch: Location,
): WorkRow["location"] {
  return {
    repository:
      patch.repository === undefined ? old.repository : patch.repository,
    checkout: patch.checkout === undefined ? old.checkout : patch.checkout,
    branch: patch.branch === undefined ? old.branch : patch.branch,
    targetBranch:
      patch.target_branch === undefined
        ? old.targetBranch
        : patch.target_branch,
    baseCommit:
      patch.base_commit === undefined ? old.baseCommit : patch.base_commit,
    paths: patch.paths === undefined ? old.paths : [...patch.paths],
  };
}

/** A work record as tool results show it. */
export function workResult(work: WorkRow, taskKey: string) {
  return {
    id: work.id,
    task_id: taskKey,
    identifier: work.identifier,
    issue_id: work.issueId,
    session_id: work.sessionId,
    status: work.status,
    blocker: work.blocker,
    location: {
      repository: work.location.repository,
      checkout: work.location.checkout,
      branch: work.location.branch,
      target_branch: work.location.targetBranch,
      base_commit: work.location.baseCommit,
      paths: [...work.location.paths],
    },
    commit: work.commit,
    integration_commit: work.integrationCommit,
    claim_comment_id: work.claimCommentId,
    predecessor_work_id: work.predecessorWorkId,
    revision: work.revision,
    created_at: work.createdAt,
    updated_at: work.updatedAt,
  };
}
export type WorkResult = ReturnType<typeof workResult>;

/** An issue as tool results show it. */
export function issueResult(issue: Issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    state: issue.stateName,
    state_type: issue.stateType,
  };
}
