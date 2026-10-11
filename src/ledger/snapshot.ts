// The read model the checks consume: every task of a project as the issue
// stands in Linear (cached locally), with its plan key, reported status and
// the standard parsed from its description, plus the project policy and the
// open work. Built from the local store only, so hooks can use it without a
// network call; tools refresh the cache through the reconciler first.

import type { Issue } from "../linear/api.js";
import {
  parseDescription,
  toTaskDetails,
  type TaskSections,
} from "../linear/sections.js";
import { taskStatusOf } from "../linear/states.js";
import type {
  JournalRevision,
  LocalStore,
  ProjectKey,
  ProjectRow,
  WorkRow,
} from "../local/types.js";
import {
  projectPolicySchema,
  type ProjectPolicy,
  type TaskDetails,
  type TaskState,
} from "../schemas.js";
import type { StandardTask } from "../jev/standard.js";

/** One task: a Linear issue in the project, addressed by plan key or identifier. */
export interface TaskView extends StandardTask {
  /** The plan key, or the issue identifier when the plan has none for it. */
  readonly key: string;
  readonly issueId: string;
  readonly identifier: string;
  readonly url: string;
  /** The title without its `KEY: ` prefix. */
  readonly title: string;
  readonly status: TaskState;
  readonly stateName: string;
  /** Linear's state type (`triage` reads as pending but is never offered). */
  readonly stateType: Issue["stateType"];
  readonly labels: readonly string[];
  readonly sections: TaskSections;
  readonly details: TaskDetails;
  readonly description: string;
  readonly parentIssueId: string | null;
  readonly milestoneId: string | null;
  readonly updatedAt: string;
  /** When the issue last reached a completed state; null while it is not completed. */
  readonly completedAt: string | null;
  /** Whether the description has readable acceptance criteria. */
  readonly hasStandard: boolean;
}

export interface Snapshot {
  readonly projectKey: ProjectKey;
  readonly planRevision: number;
  readonly policy: ProjectPolicy | undefined;
  readonly tasks: readonly TaskView[];
  readonly openWork: readonly WorkRow[];
}

/** The project's policy as last read from Linear; undefined when there is none. */
export function policyOf(project: ProjectRow): ProjectPolicy | undefined {
  if (project.policy === null) return undefined;
  const parsed = projectPolicySchema.safeParse(project.policy);
  return parsed.success ? parsed.data : undefined;
}

/** Issue id to plan key, from a plan revision. */
export function keysOf(
  journal: JournalRevision | undefined,
): Map<string, string> {
  return new Map(
    (journal?.tasks ?? []).map((task) => [task.issueId, task.key]),
  );
}

/** Strips the `KEY: ` prefix the tool puts on issue titles. */
export function plainTitle(title: string, key: string): string {
  const prefix = `${key}: `;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

export interface SnapshotInput {
  readonly project: ProjectRow;
  readonly issues: readonly Issue[];
  readonly journal: JournalRevision | undefined;
  /** Label id to name; issues show no labels when it is empty. */
  readonly labelNames: ReadonlyMap<string, string>;
  /** The workflow state that means awaiting integration, when the team has one. */
  readonly reviewStateId: string | null;
  readonly openWork: readonly WorkRow[];
}

/** One issue as a task view. */
export function taskView(
  issue: Issue,
  key: string,
  labelNames: ReadonlyMap<string, string>,
  reviewStateId: string | null,
): TaskView {
  const labels = issue.labelIds.flatMap((id) => {
    const name = labelNames.get(id);
    return name === undefined ? [] : [name];
  });
  const parsed = parseDescription(issue.description);
  const details = toTaskDetails(parsed.sections);
  return {
    key,
    issueId: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    title: plainTitle(issue.title, key),
    status: taskStatusOf(issue, new Set(labels), {
      review:
        reviewStateId === null
          ? null
          : { id: reviewStateId, name: "", type: "started", position: 0 },
    }),
    stateName: issue.stateName,
    stateType: issue.stateType,
    labels,
    sections: parsed.sections,
    details,
    description: issue.description,
    parentIssueId: issue.parentId,
    milestoneId: issue.projectMilestoneId,
    updatedAt: issue.updatedAt,
    completedAt: issue.completedAt,
    hasStandard: (details.criteria ?? []).length > 0,
  };
}

/**
 * A started issue with open work of this machine reads blocked or awaiting
 * integration from that work's own state, not from a `vc:blocked` or
 * `vc:awaiting-integration` label someone else put on it; the review state
 * itself still means awaiting integration.
 */
function withWorkState(
  task: TaskView,
  issue: Issue,
  openWork: readonly WorkRow[],
  reviewStateId: string | null,
): TaskView {
  const work = openWork.find(
    (entry) =>
      entry.issueId === issue.id &&
      (entry.status === "in_progress" ||
        entry.status === "blocked" ||
        entry.status === "awaiting_integration"),
  );
  if (work === undefined || issue.stateType !== "started") return task;
  const inReview = reviewStateId !== null && issue.stateId === reviewStateId;
  const status: TaskState =
    work.status === "blocked"
      ? "blocked"
      : work.status === "awaiting_integration" || inReview
        ? "awaiting_integration"
        : "in_progress";
  return status === task.status ? task : { ...task, status };
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const keys = keysOf(input.journal);
  const tasks = input.issues
    .filter((issue) => issue.projectId === input.project.linearProjectId)
    .map((issue) =>
      withWorkState(
        taskView(
          issue,
          keys.get(issue.id) ?? issue.identifier,
          input.labelNames,
          input.reviewStateId,
        ),
        issue,
        input.openWork,
        input.reviewStateId,
      ),
    )
    .sort(
      (left, right) =>
        left.identifier.localeCompare(right.identifier, "en", {
          numeric: true,
        }) || left.issueId.localeCompare(right.issueId),
    );
  return {
    projectKey: input.project.key,
    planRevision: input.project.planRevision,
    policy: policyOf(input.project),
    tasks,
    openWork: input.openWork,
  };
}

/** The snapshot from the local store alone: cached issues, the current plan revision, open work. */
export function localSnapshot(
  store: LocalStore,
  project: ProjectRow,
  /** By default the names the MCP server last read from Linear. */
  labelNames: ReadonlyMap<string, string> = store.labelNames(),
  reviewStateId: string | null = null,
): Snapshot {
  return buildSnapshot({
    project,
    issues: store.cachedIssues(project.key),
    journal:
      project.planRevision === 0
        ? undefined
        : store.revision(project.key, project.planRevision),
    labelNames,
    reviewStateId,
    openWork: store.openWork(project.key),
  });
}

/** A task by plan key or issue identifier (identifiers match in any case). */
export function findTask(
  snapshot: Snapshot,
  ref: string,
): TaskView | undefined {
  const upper = ref.toUpperCase();
  return (
    snapshot.tasks.find((task) => task.key === ref) ??
    snapshot.tasks.find((task) => task.identifier.toUpperCase() === upper)
  );
}

/** Children of a task: issues whose Linear parent is this task's issue. */
export function childrenOf(snapshot: Snapshot, task: TaskView): TaskView[] {
  return snapshot.tasks.filter((child) => child.parentIssueId === task.issueId);
}
