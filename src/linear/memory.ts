// MemoryLinearApi: a deterministic, in-memory Linear for tests.
//
// It seeds one workspace with a viewer, a second (human) user, one team `TA`
// with Linear's default workflow states, and the workspace project statuses.
// Writes are validated the way Linear validated them when checked live on
// 2026-10-10 (field limits, colors, icons, duplicate client ids, duplicate
// label names, label parents), and fail with the same messages, so code that
// passes against this fake sees the same errors against Linear.
//
// Behaviours copied from Linear because callers depend on them:
//   - server timestamps come from an injectable clock; the default advances
//     one millisecond per call, so createdAt ordering is strict;
//   - removing a label the issue does not carry fails with `invalid`
//     "Label <id> is not on issue <id> and cannot be removed.";
//   - comments and reactions do not change the issue's updatedAt; field,
//     state and label changes do;
//   - a new issue starts in the team's first backlog state, a new project in
//     the Backlog status, and a project update without health is onTrack;
//   - deleting a project trashes it and archives its issues;
//   - reaction emoji `thumbsup` is stored as `+1`;
//   - label groups are single-select unless the workspace enables
//     multi-select groups (Example Workspace does not), and an issue carries at
//     most one label from a single-select group.
//
// Test helpers beyond LinearApi act as a human or as Linear would:
// setPullRequests, addHumanComment, addReaction, moveIssue, archiveIssue,
// deleteDocument, and failNext to make the next call throw a LinearError.
// exportState and
// importState move the whole workspace to and from JSON, so processes can
// share one fake workspace through a file (src/linear/memory-file.ts).

import type {
  Comment,
  Document,
  ExternalLink,
  Health,
  Issue,
  IssueFields,
  IssueFilter,
  Label,
  LinearApi,
  LinkedPullRequest,
  Milestone,
  NewDocument,
  NewIssue,
  NewLabel,
  NewMilestone,
  NewProject,
  Page,
  Project,
  ProjectFields,
  ProjectStatus,
  ProjectUpdate,
  RateLimit,
  Relation,
  RelationType,
  Team,
  Viewer,
  WorkflowState,
} from "./api.js";
import { z } from "zod";
import { LinearError, type LinearErrorKind } from "./errors.js";
import { isValidIcon } from "./icons.js";

export interface MemoryLinearApiOptions {
  /**
   * Server clock, epoch milliseconds. Called once per timestamp Linear would
   * assign. Default: 2026-01-01T00:00:00Z, advancing 1 ms per call.
   */
  readonly now?: () => number;
  /**
   * Whether the workspace allows multi-select label groups. Example Workspace
   * does not ("Multi-select label groups are not enabled for this
   * workspace."), so the default is false.
   */
  readonly multiSelectLabelGroups?: boolean;
}

/** Fixed ids of the seeded workspace, for assertions. */
export const MEMORY_IDS = {
  organization: "00000000-0000-4000-8000-000000000001",
  viewer: "00000000-0000-4000-8000-000000000002",
  human: "00000000-0000-4000-8000-000000000003",
  team: "00000000-0000-4000-8000-000000000004",
} satisfies Record<string, string>;

const URL_KEY = "example-workspace";
const PAGE_SIZE = 50;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const URL_PATTERN = /^https?:\/\/[^\s/$.?#][^\s]*$/iu;

const MESSAGES = {
  description: "description must be shorter than or equal to 255 characters.",
  color: "color must be a hexadecimal color.",
  icon: "icon is not a valid icon.",
  priority: "priority must not be greater than 4.",
  priorityLow: "priority must not be less than 0.",
  title: "title must be longer than or equal to 1 characters.",
  milestoneName: "name must be longer than or equal to 2 characters.",
  link: "The link URL is not valid.",
  labelParent: "Cannot add a label to a non-group parent.",
  multiSelect: "Multi-select label groups are not enabled for this workspace.",
} satisfies Record<string, string>;

interface IssueRecord {
  id: string;
  number: number;
  teamId: string;
  title: string;
  description: string;
  stateId: string;
  priority: number;
  estimate: number | null;
  labelIds: string[];
  projectId: string | null;
  projectMilestoneId: string | null;
  parentId: string | null;
  assigneeId: string | null;
  subscriberIds: string[];
  dueDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  archived: boolean;
}

interface CommentRecord {
  id: string;
  issueId: string;
  body: string;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  reactions: { emoji: string; userId: string | null }[];
}

interface ProjectRecord {
  id: string;
  slugId: string;
  name: string;
  icon: string | null;
  color: string;
  description: string;
  content: string;
  statusId: string;
  priority: number;
  leadId: string | null;
  memberIds: string[];
  labelIds: string[];
  startDate: string | null;
  targetDate: string | null;
  teamIds: string[];
  updatedAt: string;
  trashed: boolean;
}

interface LabelRecord extends Label {
  readonly groupType: string | null;
}

const stateTypeSchema = z.enum([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);
const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
  isGroup: z.boolean(),
  parentId: z.string().nullable(),
  teamId: z.string().nullable(),
});

/** The whole fake workspace as JSON; see exportState and importState. */
export const memoryStateSchema = z.object({
  version: z.literal(1),
  counter: z.number().int(),
  tick: z.number(),
  issueNumbers: z.array(z.tuple([z.string(), z.number().int()])),
  teams: z.array(
    z.object({ id: z.string(), key: z.string(), name: z.string() }),
  ),
  states: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: stateTypeSchema,
      position: z.number(),
      teamId: z.string(),
    }),
  ),
  statuses: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum([
        "backlog",
        "planned",
        "started",
        "paused",
        "completed",
        "canceled",
      ]),
    }),
  ),
  labels: z.array(labelSchema.extend({ groupType: z.string().nullable() })),
  projectLabels: z.array(labelSchema),
  projects: z.array(
    z.object({
      id: z.string(),
      slugId: z.string(),
      name: z.string(),
      icon: z.string().nullable(),
      color: z.string(),
      description: z.string(),
      content: z.string(),
      statusId: z.string(),
      priority: z.number(),
      leadId: z.string().nullable(),
      memberIds: z.array(z.string()),
      labelIds: z.array(z.string()),
      startDate: z.string().nullable(),
      targetDate: z.string().nullable(),
      teamIds: z.array(z.string()),
      updatedAt: z.string(),
      trashed: z.boolean(),
    }),
  ),
  milestones: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      name: z.string(),
      description: z.string(),
      targetDate: z.string().nullable(),
      sortOrder: z.number(),
    }),
  ),
  documents: z.array(
    z.object({
      id: z.string(),
      projectId: z.string().nullable(),
      title: z.string(),
      icon: z.string().nullable(),
      color: z.string().nullable(),
      content: z.string(),
      updatedAt: z.string(),
    }),
  ),
  links: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      url: z.string(),
      projectId: z.string(),
    }),
  ),
  issues: z.array(
    z.object({
      id: z.string(),
      number: z.number().int(),
      teamId: z.string(),
      title: z.string(),
      description: z.string(),
      stateId: z.string(),
      priority: z.number(),
      estimate: z.number().nullable(),
      labelIds: z.array(z.string()),
      projectId: z.string().nullable(),
      projectMilestoneId: z.string().nullable(),
      parentId: z.string().nullable(),
      assigneeId: z.string().nullable(),
      subscriberIds: z.array(z.string()),
      dueDate: z.string().nullable(),
      sortOrder: z.number(),
      createdAt: z.string(),
      updatedAt: z.string(),
      completedAt: z.string().nullable(),
      canceledAt: z.string().nullable(),
      archived: z.boolean(),
    }),
  ),
  relations: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["blocks", "duplicate", "related", "similar"]),
      issueId: z.string(),
      relatedIssueId: z.string(),
    }),
  ),
  comments: z.array(
    z.object({
      id: z.string(),
      issueId: z.string(),
      body: z.string(),
      userId: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      reactions: z.array(
        z.object({ emoji: z.string(), userId: z.string().nullable() }),
      ),
    }),
  ),
  updates: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      health: z.enum(["onTrack", "atRisk", "offTrack"]).nullable(),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
  pullRequests: z.array(
    z.tuple([
      z.string(),
      z.array(
        z.object({
          url: z.string(),
          title: z.string(),
          source: z.enum(["github", "gitlab"]),
          number: z.number().nullable(),
          branch: z.string().nullable(),
          draft: z.boolean().nullable(),
          createdAt: z.string().nullable(),
          closedAt: z.string().nullable(),
          mergedAt: z.string().nullable(),
          hasConflicts: z.boolean().nullable(),
        }),
      ),
    ]),
  ),
});
export type MemoryState = z.infer<typeof memoryStateSchema>;

/** In-memory LinearApi. See the module header for what it models. */
export class MemoryLinearApi implements LinearApi {
  private readonly clock: () => number;
  private readonly multiSelectLabelGroups: boolean;
  private counter = 100;
  private tick = Date.parse("2026-01-01T00:00:00.000Z");
  private readonly failures: LinearError[] = [];
  private readonly teamList: Team[];
  private readonly states: (WorkflowState & { teamId: string })[];
  private readonly statuses: ProjectStatus[];
  private readonly labelMap = new Map<string, LabelRecord>();
  private readonly projectLabelMap = new Map<string, Label>();
  private readonly projectMap = new Map<string, ProjectRecord>();
  private readonly milestoneMap = new Map<string, Milestone>();
  private readonly documentMap = new Map<string, Document>();
  /** Ids of documents deleteDocument trashed: Linear still refuses to reuse them. */
  private readonly trashedDocumentIds = new Set<string>();
  private readonly linkMap = new Map<
    string,
    ExternalLink & { projectId: string }
  >();
  private readonly issueMap = new Map<string, IssueRecord>();
  private readonly relationMap = new Map<string, Relation>();
  private readonly commentMap = new Map<string, CommentRecord>();
  private readonly updateMap = new Map<string, ProjectUpdate>();
  private readonly pullRequestMap = new Map<string, LinkedPullRequest[]>();
  private readonly issueNumbers = new Map<string, number>();

  constructor(options: MemoryLinearApiOptions = {}) {
    this.clock = options.now ?? (() => this.tick++);
    this.multiSelectLabelGroups = options.multiSelectLabelGroups ?? false;
    this.teamList = [
      { id: MEMORY_IDS.team, key: "TA", name: "Example Workspace" },
    ];
    const state = (
      name: string,
      type: WorkflowState["type"],
      position: number,
    ): WorkflowState & { teamId: string } => ({
      id: this.newId(),
      name,
      type,
      position,
      teamId: MEMORY_IDS.team,
    });
    this.states = [
      state("Triage", "triage", -1),
      state("Backlog", "backlog", 0),
      state("Todo", "unstarted", 1),
      state("In Progress", "started", 2),
      state("In Review", "started", 3),
      state("Done", "completed", 4),
      state("Canceled", "canceled", 5),
      state("Duplicate", "canceled", 6),
    ];
    const status = (
      name: string,
      type: ProjectStatus["type"],
    ): ProjectStatus => ({ id: this.newId(), name, type });
    this.statuses = [
      status("Backlog", "backlog"),
      status("Planned", "planned"),
      status("In Progress", "started"),
      status("Completed", "completed"),
      status("Canceled", "canceled"),
    ];
  }

  // -------------------------------------------------------------------------
  // Test helpers (not part of LinearApi)

  /** The seeded human user's id; authors addHumanComment comments. */
  get humanUserId(): string {
    return MEMORY_IDS.human;
  }

  /** The seeded team's id. */
  get teamId(): string {
    return MEMORY_IDS.team;
  }

  /** Makes the next LinearApi call throw a LinearError of `kind`. Queues. */
  failNext(
    kind: LinearErrorKind,
    options: { readonly message?: string; readonly retryAfterMs?: number } = {},
  ): void {
    const retryAfterMs =
      options.retryAfterMs ?? (kind === "rate_limited" ? 1000 : undefined);
    this.failures.push(
      new LinearError(kind, options.message ?? `Injected ${kind} failure.`, {
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }),
    );
  }

  /** The whole workspace as JSON-safe data. */
  exportState(): MemoryState {
    return {
      version: 1,
      counter: this.counter,
      tick: this.tick,
      issueNumbers: [...this.issueNumbers],
      teams: this.teamList.map((team) => ({ ...team })),
      states: this.states.map((state) => ({ ...state })),
      statuses: this.statuses.map((status) => ({ ...status })),
      labels: [...this.labelMap.values()].map((label) => ({ ...label })),
      projectLabels: [...this.projectLabelMap.values()].map((label) => ({
        ...label,
      })),
      projects: [...this.projectMap.values()].map((project) => ({
        ...project,
      })),
      milestones: [...this.milestoneMap.values()].map((item) => ({ ...item })),
      documents: [...this.documentMap.values()].map((item) => ({ ...item })),
      links: [...this.linkMap.values()].map((item) => ({ ...item })),
      issues: [...this.issueMap.values()].map((item) => ({ ...item })),
      relations: [...this.relationMap.values()].map((item) => ({ ...item })),
      comments: [...this.commentMap.values()].map((item) => ({
        ...item,
        reactions: item.reactions.map((reaction) => ({ ...reaction })),
      })),
      updates: [...this.updateMap.values()].map((item) => ({ ...item })),
      pullRequests: [...this.pullRequestMap].map(([id, prs]) => [
        id,
        prs.map((pr) => ({ ...pr })),
      ]),
    };
  }

  /** Replaces the whole workspace with `state` (from exportState). */
  importState(state: MemoryState): void {
    const parsed = memoryStateSchema.parse(state);
    this.counter = parsed.counter;
    this.tick = parsed.tick;
    const refill = <K, V>(map: Map<K, V>, entries: Iterable<[K, V]>): void => {
      map.clear();
      for (const [key, value] of entries) map.set(key, value);
    };
    refill(this.issueNumbers, parsed.issueNumbers);
    this.teamList.splice(0, this.teamList.length, ...parsed.teams);
    this.states.splice(0, this.states.length, ...parsed.states);
    this.statuses.splice(0, this.statuses.length, ...parsed.statuses);
    refill(
      this.labelMap,
      parsed.labels.map((label): [string, LabelRecord] => [label.id, label]),
    );
    refill(
      this.projectLabelMap,
      parsed.projectLabels.map((label): [string, Label] => [label.id, label]),
    );
    refill(
      this.projectMap,
      parsed.projects.map((item): [string, ProjectRecord] => [item.id, item]),
    );
    refill(
      this.milestoneMap,
      parsed.milestones.map((item): [string, Milestone] => [item.id, item]),
    );
    refill(
      this.documentMap,
      parsed.documents.map((item): [string, Document] => [item.id, item]),
    );
    refill(
      this.linkMap,
      parsed.links.map(
        (item): [string, ExternalLink & { projectId: string }] => [
          item.id,
          item,
        ],
      ),
    );
    refill(
      this.issueMap,
      parsed.issues.map((item): [string, IssueRecord] => [item.id, item]),
    );
    refill(
      this.relationMap,
      parsed.relations.map((item): [string, Relation] => [item.id, item]),
    );
    refill(
      this.commentMap,
      parsed.comments.map((item): [string, CommentRecord] => [item.id, item]),
    );
    refill(
      this.updateMap,
      parsed.updates.map((item): [string, ProjectUpdate] => [item.id, item]),
    );
    refill(this.pullRequestMap, parsed.pullRequests);
  }

  /** Replaces the pull requests Linear's Git integration links to an issue. */
  setPullRequests(issueId: string, prs: readonly LinkedPullRequest[]): void {
    this.requireIssueRecord(issueId);
    this.pullRequestMap.set(issueId, [...prs]);
  }

  /** Posts a comment as the seeded human user. */
  addHumanComment(issueId: string, body: string): Comment {
    const issue = this.requireIssueRecord(issueId);
    const at = this.stamp();
    const record: CommentRecord = {
      id: this.newId(),
      issueId: issue.id,
      body,
      userId: MEMORY_IDS.human,
      createdAt: at,
      updatedAt: at,
      reactions: [],
    };
    this.commentMap.set(record.id, record);
    return toComment(record);
  }

  /** Adds an emoji reaction to a comment, as `userId` (default the human). */
  addReaction(
    commentId: string,
    emoji: string,
    userId: string = MEMORY_IDS.human,
  ): void {
    const comment = this.commentMap.get(commentId);
    if (comment === undefined) throw notFound("Comment");
    const name = emoji === "thumbsup" ? "+1" : emoji;
    if (
      comment.reactions.some(
        (reaction) => reaction.emoji === name && reaction.userId === userId,
      )
    ) {
      return;
    }
    comment.reactions.push({ emoji: name, userId });
  }

  /** Moves an issue to `stateId` the way a person in Linear's UI would. */
  moveIssue(issueId: string, stateId: string): Issue {
    const issue = this.requireIssueRecord(issueId);
    this.applyState(issue, this.requireState(issue.teamId, stateId));
    issue.updatedAt = this.stamp();
    return this.toIssue(issue);
  }

  /**
   * Trashes a document the way a person in Linear's UI would: it leaves the
   * project's documents, and a create that reuses its id is refused as
   * "already exists".
   */
  deleteDocument(id: string): void {
    if (!this.documentMap.delete(id)) throw notFound("Document");
    this.trashedDocumentIds.add(id);
  }

  /** Archives an issue, as Linear's auto-archive or a person would. */
  archiveIssue(issueId: string): void {
    const issue = this.requireIssueRecord(issueId);
    issue.archived = true;
    issue.updatedAt = this.stamp();
  }

  // -------------------------------------------------------------------------
  // Workspace

  rateLimit(): RateLimit | null {
    return null;
  }

  async viewer(): Promise<Viewer> {
    this.gate();
    return {
      id: MEMORY_IDS.viewer,
      name: "Mike Davis",
      email: "mike@example.com",
      admin: true,
      organization: {
        id: MEMORY_IDS.organization,
        name: "Example Workspace",
        urlKey: URL_KEY,
      },
    };
  }

  async teams(): Promise<readonly Team[]> {
    this.gate();
    return this.teamList.map((team) => ({ ...team }));
  }

  async workflowStates(teamId: string): Promise<readonly WorkflowState[]> {
    this.gate();
    return this.states
      .filter((state) => state.teamId === teamId)
      .sort((left, right) => left.position - right.position)
      .map(({ id, name, type, position }) => ({ id, name, type, position }));
  }

  async projectStatuses(): Promise<readonly ProjectStatus[]> {
    this.gate();
    return this.statuses.map((status) => ({ ...status }));
  }

  async labels(teamId: string): Promise<readonly Label[]> {
    this.gate();
    return [...this.labelMap.values()]
      .filter((label) => label.teamId === null || label.teamId === teamId)
      .map(toLabel);
  }

  async createLabel(input: NewLabel): Promise<Label> {
    this.gate();
    this.checkNewId(input.id, "IssueLabel", this.labelMap);
    if (input.color !== undefined) checkColor(input.color);
    const teamId = input.teamId ?? null;
    if (teamId !== null) this.requireTeam(teamId);
    const name = input.name.trim();
    if (name === "") throw invalid("name should not be empty.");
    const clash = [...this.labelMap.values()].find(
      (label) =>
        label.name.toLowerCase() === name.toLowerCase() &&
        (teamId === null || label.teamId === null || label.teamId === teamId),
    );
    if (clash !== undefined) {
      throw invalid(
        `Label "${name}" already exists in the ${clash.teamId === null || teamId === null ? "workspace" : "team"}. Please pick a different name and try again.`,
      );
    }
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = this.labelMap.get(parentId);
      if (parent === undefined) throw notFound("IssueLabel");
      if (!parent.isGroup) throw invalid(MESSAGES.labelParent);
    }
    if (
      input.isGroup === true &&
      input.groupType === "multiSelect" &&
      !this.multiSelectLabelGroups
    ) {
      throw invalid(MESSAGES.multiSelect);
    }
    const record: LabelRecord = {
      id: input.id ?? this.newId(),
      name,
      color: input.color ?? "#bec2c8",
      description: input.description ?? null,
      isGroup: input.isGroup ?? false,
      parentId,
      teamId,
      groupType:
        input.isGroup === true ? (input.groupType ?? "singleSelect") : null,
    };
    this.labelMap.set(record.id, record);
    return toLabel(record);
  }

  async projectLabels(): Promise<readonly Label[]> {
    this.gate();
    return [...this.projectLabelMap.values()].map((label) => ({ ...label }));
  }

  async createProjectLabel(
    input: Omit<NewLabel, "groupType" | "teamId">,
  ): Promise<Label> {
    this.gate();
    this.checkNewId(input.id, "ProjectLabel", this.projectLabelMap);
    if (input.color !== undefined) checkColor(input.color);
    const name = input.name.trim();
    if (name === "") throw invalid("name should not be empty.");
    if (
      [...this.projectLabelMap.values()].some(
        (label) => label.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw invalid(
        `Project label "${name}" already exists. Please pick a different name and try again.`,
      );
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = this.projectLabelMap.get(parentId);
      if (parent === undefined) throw notFound("ProjectLabel");
      if (!parent.isGroup) throw invalid(MESSAGES.labelParent);
    }
    const label: Label = {
      id: input.id ?? this.newId(),
      name,
      color: input.color ?? "#bec2c8",
      description: input.description ?? null,
      isGroup: input.isGroup ?? false,
      parentId,
      teamId: null,
    };
    this.projectLabelMap.set(label.id, label);
    return { ...label };
  }

  /** Deletes a project label. Not part of LinearApi; mirrors GraphqlLinearApi. */
  async deleteProjectLabel(id: string): Promise<void> {
    this.gate();
    if (!this.projectLabelMap.delete(id)) throw notFound("ProjectLabel");
    for (const project of this.projectMap.values())
      project.labelIds = project.labelIds.filter((labelId) => labelId !== id);
  }

  /** Deletes a label. Not part of LinearApi; mirrors GraphqlLinearApi. */
  async deleteLabel(id: string): Promise<void> {
    this.gate();
    if (!this.labelMap.delete(id)) throw notFound("IssueLabel");
    for (const issue of this.issueMap.values()) {
      issue.labelIds = issue.labelIds.filter((labelId) => labelId !== id);
    }
  }

  // -------------------------------------------------------------------------
  // Projects

  async project(idOrSlug: string): Promise<Project | null> {
    this.gate();
    const record =
      this.projectMap.get(idOrSlug) ??
      [...this.projectMap.values()].find(
        (project) => project.slugId === idOrSlug,
      );
    return record === undefined || record.trashed
      ? null
      : this.toProject(record);
  }

  async createProject(input: NewProject): Promise<Project> {
    this.gate();
    this.checkNewId(input.id, "Project", this.projectMap);
    this.checkProjectFields(input);
    if (input.teamIds.length === 0)
      throw invalid("teamIds should not be empty.");
    for (const teamId of input.teamIds) this.requireTeam(teamId);
    const backlog = this.statuses.find((status) => status.type === "backlog");
    const id = input.id ?? this.newId();
    const record: ProjectRecord = {
      id,
      slugId: id.replace(/-/gu, "").slice(-12),
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? "#bec2c8",
      description: input.description ?? "",
      content: input.content ?? "",
      statusId: input.statusId ?? backlog?.id ?? "",
      priority: input.priority ?? 0,
      leadId: input.leadId ?? null,
      memberIds: [...(input.memberIds ?? [])],
      labelIds: [...(input.labelIds ?? [])],
      startDate: input.startDate ?? null,
      targetDate: input.targetDate ?? null,
      teamIds: [...input.teamIds],
      updatedAt: this.stamp(),
      trashed: false,
    };
    this.projectMap.set(id, record);
    return this.toProject(record);
  }

  async updateProject(
    id: string,
    input: Partial<ProjectFields>,
  ): Promise<Project> {
    this.gate();
    const record = this.requireProjectRecord(id);
    this.checkProjectFields(input);
    if (input.name !== undefined) record.name = input.name;
    if (input.icon !== undefined) record.icon = input.icon;
    if (input.color !== undefined) record.color = input.color;
    if (input.description !== undefined) record.description = input.description;
    if (input.content !== undefined) record.content = input.content;
    if (input.statusId !== undefined) record.statusId = input.statusId;
    if (input.priority !== undefined) record.priority = input.priority;
    if (input.leadId !== undefined) record.leadId = input.leadId;
    if (input.memberIds !== undefined) record.memberIds = [...input.memberIds];
    if (input.labelIds !== undefined) record.labelIds = [...input.labelIds];
    if (input.startDate !== undefined) record.startDate = input.startDate;
    if (input.targetDate !== undefined) record.targetDate = input.targetDate;
    record.updatedAt = this.stamp();
    return this.toProject(record);
  }

  async deleteProject(id: string): Promise<void> {
    this.gate();
    const record = this.requireProjectRecord(id);
    record.trashed = true;
    record.updatedAt = this.stamp();
    for (const issue of this.issueMap.values()) {
      if (issue.projectId === id && !issue.archived) {
        issue.archived = true;
        issue.updatedAt = this.stamp();
      }
    }
  }

  async projects(nameContains?: string): Promise<readonly Project[]> {
    this.gate();
    const needle = nameContains?.toLowerCase() ?? "";
    return [...this.projectMap.values()]
      .filter(
        (project) =>
          !project.trashed && project.name.toLowerCase().includes(needle),
      )
      .map((project) => this.toProject(project));
  }

  // -------------------------------------------------------------------------
  // Milestones, documents, links

  async milestones(projectId: string): Promise<readonly Milestone[]> {
    this.gate();
    this.requireProjectRecord(projectId);
    return [...this.milestoneMap.values()]
      .filter((milestone) => milestone.projectId === projectId)
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((milestone) => ({ ...milestone }));
  }

  async createMilestone(input: NewMilestone): Promise<Milestone> {
    this.gate();
    this.checkNewId(input.id, "ProjectMilestone", this.milestoneMap);
    this.requireProjectRecord(input.projectId);
    checkMilestoneName(input.name);
    const siblings = [...this.milestoneMap.values()].filter(
      (milestone) => milestone.projectId === input.projectId,
    );
    const milestone: Milestone = {
      id: input.id ?? this.newId(),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? "",
      targetDate: input.targetDate ?? null,
      sortOrder:
        input.sortOrder ??
        Math.max(0, ...siblings.map((sibling) => sibling.sortOrder)) + 1000,
    };
    this.milestoneMap.set(milestone.id, milestone);
    return { ...milestone };
  }

  async updateMilestone(
    id: string,
    input: Partial<Omit<NewMilestone, "id" | "projectId">>,
  ): Promise<Milestone> {
    this.gate();
    const current = this.milestoneMap.get(id);
    if (current === undefined) throw notFound("ProjectMilestone");
    if (input.name !== undefined) checkMilestoneName(input.name);
    const next: Milestone = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      ...(input.targetDate === undefined
        ? {}
        : { targetDate: input.targetDate }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    };
    this.milestoneMap.set(id, next);
    return { ...next };
  }

  async documents(projectId: string): Promise<readonly Document[]> {
    this.gate();
    return [...this.documentMap.values()]
      .filter((document) => document.projectId === projectId)
      .map((document) => ({ ...document }));
  }

  async createDocument(input: NewDocument): Promise<Document> {
    this.gate();
    this.checkNewId(input.id, "Document", this.documentMap);
    if (input.id !== undefined && this.trashedDocumentIds.has(input.id))
      throw invalid(`Entity Document with id ${input.id} already exists.`);
    this.requireProjectRecord(input.projectId);
    if (input.icon !== undefined) checkIcon(input.icon);
    if (input.color !== undefined) checkColor(input.color);
    const document: Document = {
      id: input.id ?? this.newId(),
      projectId: input.projectId,
      title: input.title,
      icon: input.icon ?? null,
      color: input.color ?? null,
      content: input.content ?? "",
      updatedAt: this.stamp(),
    };
    this.documentMap.set(document.id, document);
    return { ...document };
  }

  async updateDocument(
    id: string,
    input: Partial<Omit<NewDocument, "id" | "projectId">>,
  ): Promise<Document> {
    this.gate();
    const current = this.documentMap.get(id);
    if (current === undefined) throw notFound("Document");
    if (input.icon !== undefined) checkIcon(input.icon);
    if (input.color !== undefined) checkColor(input.color);
    const next: Document = {
      ...current,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.icon === undefined ? {} : { icon: input.icon }),
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.content === undefined ? {} : { content: input.content }),
      updatedAt: this.stamp(),
    };
    this.documentMap.set(id, next);
    return { ...next };
  }

  async externalLinks(projectId: string): Promise<readonly ExternalLink[]> {
    this.gate();
    this.requireProjectRecord(projectId);
    return [...this.linkMap.values()]
      .filter((link) => link.projectId === projectId)
      .map(({ id, label, url }) => ({ id, label, url }));
  }

  async createExternalLink(
    projectId: string,
    input: {
      readonly id?: string;
      readonly label: string;
      readonly url: string;
    },
  ): Promise<ExternalLink> {
    this.gate();
    this.checkNewId(input.id, "EntityExternalLink", this.linkMap);
    this.requireProjectRecord(projectId);
    if (!URL_PATTERN.test(input.url)) throw invalid(MESSAGES.link);
    const link = {
      id: input.id ?? this.newId(),
      label: input.label,
      url: input.url,
      projectId,
    };
    this.linkMap.set(link.id, link);
    return { id: link.id, label: link.label, url: link.url };
  }

  // -------------------------------------------------------------------------
  // Issues

  async issues(filter: IssueFilter, after?: string): Promise<Page<Issue>> {
    this.gate();
    const matching = [...this.issueMap.values()]
      .filter(
        (issue) =>
          issue.projectId === filter.projectId &&
          (filter.includeArchived === true || !issue.archived) &&
          (filter.updatedAfter === undefined ||
            Date.parse(issue.updatedAt) > Date.parse(filter.updatedAfter)),
      )
      .sort(compareByUpdated);
    let start = 0;
    if (after !== undefined) {
      const cursor = decodeCursor(after);
      start = matching.findIndex(
        (issue) => compareByUpdated(issue, cursor) > 0,
      );
      if (start === -1) start = matching.length;
    }
    const slice = matching.slice(start, start + PAGE_SIZE);
    const last = slice[slice.length - 1];
    const hasMore = start + PAGE_SIZE < matching.length;
    return {
      nodes: slice.map((issue) => this.toIssue(issue)),
      next: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async issue(idOrIdentifier: string): Promise<Issue | null> {
    this.gate();
    const record = this.findIssue(idOrIdentifier);
    return record === undefined ? null : this.toIssue(record);
  }

  async createIssue(input: NewIssue): Promise<Issue> {
    this.gate();
    this.checkNewId(input.id, "Issue", this.issueMap);
    const team = this.requireTeam(input.teamId);
    const project = this.requireProjectRecord(input.projectId);
    if (input.title.trim() === "") throw invalid(MESSAGES.title);
    this.checkIssueFields(team.id, input);
    const backlog = this.states.find(
      (state) => state.teamId === team.id && state.type === "backlog",
    );
    const state =
      input.stateId === undefined
        ? backlog
        : this.requireState(team.id, input.stateId);
    if (state === undefined) throw invalid("The team has no backlog state.");
    const number = (this.issueNumbers.get(team.id) ?? 0) + 1;
    this.issueNumbers.set(team.id, number);
    const at = this.stamp();
    const record: IssueRecord = {
      id: input.id ?? this.newId(),
      number,
      teamId: team.id,
      title: input.title,
      description: input.description ?? "",
      stateId: state.id,
      priority: input.priority ?? 0,
      estimate: input.estimate ?? null,
      labelIds: [...(input.labelIds ?? [])],
      projectId: project.id,
      projectMilestoneId: input.projectMilestoneId ?? null,
      parentId: input.parentId ?? null,
      assigneeId: input.assigneeId ?? null,
      subscriberIds: [...(input.subscriberIds ?? [])],
      dueDate: input.dueDate ?? null,
      sortOrder: input.sortOrder ?? number,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      canceledAt: null,
      archived: false,
    };
    this.applyState(record, state, true);
    this.issueMap.set(record.id, record);
    return this.toIssue(record);
  }

  async updateIssue(id: string, input: IssueFields): Promise<Issue> {
    this.gate();
    const record = this.requireIssueRecord(id);
    if (input.title !== undefined && input.title.trim() === "") {
      throw invalid(MESSAGES.title);
    }
    this.checkIssueFields(record.teamId, input);
    if (input.title !== undefined) record.title = input.title;
    if (input.description !== undefined) record.description = input.description;
    if (input.stateId !== undefined) {
      this.applyState(record, this.requireState(record.teamId, input.stateId));
    }
    if (input.priority !== undefined) record.priority = input.priority;
    if (input.estimate !== undefined) record.estimate = input.estimate;
    if (input.labelIds !== undefined) record.labelIds = [...input.labelIds];
    if (input.projectMilestoneId !== undefined) {
      record.projectMilestoneId = input.projectMilestoneId;
    }
    if (input.parentId !== undefined) record.parentId = input.parentId;
    if (input.assigneeId !== undefined) record.assigneeId = input.assigneeId;
    if (input.subscriberIds !== undefined) {
      record.subscriberIds = [...input.subscriberIds];
    }
    if (input.dueDate !== undefined) record.dueDate = input.dueDate;
    if (input.sortOrder !== undefined) record.sortOrder = input.sortOrder;
    record.updatedAt = this.stamp();
    return this.toIssue(record);
  }

  async addLabel(issueId: string, labelId: string): Promise<void> {
    this.gate();
    const record = this.requireIssueRecord(issueId);
    this.requireLabel(labelId);
    if (!record.labelIds.includes(labelId)) {
      const next = [...record.labelIds, labelId];
      this.checkExclusiveLabels(next);
      record.labelIds = next;
      record.updatedAt = this.stamp();
    }
  }

  async removeLabel(issueId: string, labelId: string): Promise<void> {
    this.gate();
    const record = this.requireIssueRecord(issueId);
    this.requireLabel(labelId);
    // Real Linear refuses this; tests must go through the tolerant path.
    if (!record.labelIds.includes(labelId))
      throw new LinearError(
        "invalid",
        `Label ${labelId} is not on issue ${record.id} and cannot be removed.`,
      );
    record.labelIds = record.labelIds.filter((id) => id !== labelId);
    record.updatedAt = this.stamp();
  }

  // -------------------------------------------------------------------------
  // Relations

  async relations(issueId: string): Promise<readonly Relation[]> {
    this.gate();
    const record = this.requireIssueRecord(issueId);
    return [...this.relationMap.values()]
      .filter(
        (relation) =>
          relation.issueId === record.id ||
          relation.relatedIssueId === record.id,
      )
      .map((relation) => ({ ...relation }));
  }

  async createRelation(input: {
    readonly id?: string;
    readonly type: RelationType;
    readonly issueId: string;
    readonly relatedIssueId: string;
  }): Promise<Relation> {
    this.gate();
    this.checkNewId(input.id, "IssueRelation", this.relationMap);
    const issue = this.requireIssueRecord(input.issueId);
    const related = this.requireIssueRecord(input.relatedIssueId);
    const relation: Relation = {
      id: input.id ?? this.newId(),
      type: input.type,
      issueId: issue.id,
      relatedIssueId: related.id,
    };
    this.relationMap.set(relation.id, relation);
    return { ...relation };
  }

  async deleteRelation(id: string): Promise<void> {
    this.gate();
    if (!this.relationMap.delete(id)) throw notFound("IssueRelation");
  }

  // -------------------------------------------------------------------------
  // Comments

  async comments(issueId: string): Promise<readonly Comment[]> {
    this.gate();
    const record = this.requireIssueRecord(issueId);
    return [...this.commentMap.values()]
      .filter((comment) => comment.issueId === record.id)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map(toComment);
  }

  async createComment(input: {
    readonly id?: string;
    readonly issueId: string;
    readonly body: string;
  }): Promise<Comment> {
    this.gate();
    this.checkNewId(input.id, "Comment", this.commentMap);
    const issue = this.requireIssueRecord(input.issueId);
    const at = this.stamp();
    const record: CommentRecord = {
      id: input.id ?? this.newId(),
      issueId: issue.id,
      body: input.body,
      userId: MEMORY_IDS.viewer,
      createdAt: at,
      updatedAt: at,
      reactions: [],
    };
    this.commentMap.set(record.id, record);
    return toComment(record);
  }

  async updateComment(id: string, body: string): Promise<Comment> {
    this.gate();
    const record = this.commentMap.get(id);
    if (record === undefined) throw notFound("Comment");
    record.body = body;
    record.updatedAt = this.stamp();
    return toComment(record);
  }

  async deleteComment(id: string): Promise<void> {
    this.gate();
    if (!this.commentMap.delete(id)) throw notFound("Comment");
  }

  // -------------------------------------------------------------------------
  // Pull requests, project updates

  async pullRequests(issueId: string): Promise<readonly LinkedPullRequest[]> {
    this.gate();
    const record = this.requireIssueRecord(issueId);
    return (this.pullRequestMap.get(record.id) ?? []).map((pr) => ({ ...pr }));
  }

  async projectUpdates(projectId: string): Promise<readonly ProjectUpdate[]> {
    this.gate();
    this.requireProjectRecord(projectId);
    return [...this.updateMap.values()]
      .filter((update) => update.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((update) => ({ ...update }));
  }

  async createProjectUpdate(input: {
    readonly id?: string;
    readonly projectId: string;
    readonly body: string;
    readonly health?: Health;
  }): Promise<ProjectUpdate> {
    this.gate();
    this.checkNewId(input.id, "ProjectUpdate", this.updateMap);
    this.requireProjectRecord(input.projectId);
    const update: ProjectUpdate = {
      id: input.id ?? this.newId(),
      projectId: input.projectId,
      health: input.health ?? "onTrack",
      body: input.body,
      createdAt: this.stamp(),
    };
    this.updateMap.set(update.id, update);
    return { ...update };
  }

  // -------------------------------------------------------------------------
  // Internals

  private gate(): void {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
  }

  private stamp(): string {
    return new Date(this.clock()).toISOString();
  }

  private newId(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${this.counter.toString().padStart(12, "0")}`;
  }

  private checkNewId(
    id: string | undefined,
    entity: string,
    existing: ReadonlyMap<string, unknown>,
  ): void {
    if (id === undefined) return;
    if (id.trim() === "") throw invalid("id must not be empty.");
    if (existing.has(id)) {
      throw invalid(`Entity ${entity} with id ${id} already exists.`);
    }
  }

  private checkProjectFields(input: Partial<ProjectFields>): void {
    if (input.description !== undefined && input.description.length > 255) {
      throw invalid(MESSAGES.description);
    }
    if (input.color !== undefined) checkColor(input.color);
    if (input.icon !== undefined) checkIcon(input.icon);
    if (input.priority !== undefined) checkPriority(input.priority);
    if (
      input.statusId !== undefined &&
      !this.statuses.some((status) => status.id === input.statusId)
    ) {
      throw notFound("ProjectStatus");
    }
    for (const labelId of input.labelIds ?? []) {
      if (!this.projectLabelMap.has(labelId)) throw notFound("ProjectLabel");
    }
  }

  private checkIssueFields(teamId: string, input: IssueFields): void {
    if (input.priority !== undefined) checkPriority(input.priority);
    if (
      input.estimate !== undefined &&
      input.estimate !== null &&
      !Number.isInteger(input.estimate)
    ) {
      throw invalid("estimate must be an integer number.");
    }
    if (input.stateId !== undefined) this.requireState(teamId, input.stateId);
    for (const labelId of input.labelIds ?? []) this.requireLabel(labelId);
    if (input.labelIds !== undefined) this.checkExclusiveLabels(input.labelIds);
    if (
      input.projectMilestoneId !== undefined &&
      input.projectMilestoneId !== null &&
      !this.milestoneMap.has(input.projectMilestoneId)
    ) {
      throw notFound("ProjectMilestone");
    }
    if (input.parentId !== undefined && input.parentId !== null) {
      this.requireIssueRecord(input.parentId);
    }
  }

  /**
   * Linear applies at most one label from a single-select group to an issue:
   * "The label 'A' is in the same group as 'B'. Only one label in a group can
   * be applied to an issue."
   */
  private checkExclusiveLabels(labelIds: readonly string[]): void {
    const byGroup = new Map<string, LabelRecord>();
    for (const labelId of labelIds) {
      const label = this.requireLabel(labelId);
      if (label.parentId === null) continue;
      const group = this.labelMap.get(label.parentId);
      if (group === undefined || group.groupType === "multiSelect") continue;
      const other = byGroup.get(group.id);
      if (other !== undefined && other.id !== label.id) {
        throw invalid(
          `The label '${other.name}' is in the same group as '${label.name}'. Only one label in a group can be applied to an issue.`,
        );
      }
      byGroup.set(group.id, label);
    }
  }

  private applyState(
    issue: IssueRecord,
    state: WorkflowState & { teamId: string },
    initial = false,
  ): void {
    if (!initial && issue.stateId === state.id) return;
    issue.stateId = state.id;
    const at = this.stamp();
    issue.completedAt = state.type === "completed" ? at : null;
    issue.canceledAt = state.type === "canceled" ? at : null;
  }

  private requireTeam(teamId: string): Team {
    const team = this.teamList.find((candidate) => candidate.id === teamId);
    if (team === undefined) throw notFound("Team");
    return team;
  }

  private requireState(
    teamId: string,
    stateId: string,
  ): WorkflowState & { teamId: string } {
    const state = this.states.find(
      (candidate) => candidate.id === stateId && candidate.teamId === teamId,
    );
    if (state === undefined) throw notFound("WorkflowState");
    return state;
  }

  private requireLabel(labelId: string): LabelRecord {
    const label = this.labelMap.get(labelId);
    if (label === undefined) throw notFound("IssueLabel");
    return label;
  }

  private requireProjectRecord(id: string): ProjectRecord {
    const record = this.projectMap.get(id);
    if (record === undefined || record.trashed) throw notFound("Project");
    return record;
  }

  private findIssue(idOrIdentifier: string): IssueRecord | undefined {
    const direct = this.issueMap.get(idOrIdentifier);
    if (direct !== undefined) return direct;
    const match = /^([A-Za-z0-9]+)-(\d+)$/u.exec(idOrIdentifier);
    if (match === null) return undefined;
    const key = match[1]?.toUpperCase();
    const number = Number(match[2]);
    const team = this.teamList.find((candidate) => candidate.key === key);
    if (team === undefined) return undefined;
    return [...this.issueMap.values()].find(
      (issue) => issue.teamId === team.id && issue.number === number,
    );
  }

  private requireIssueRecord(idOrIdentifier: string): IssueRecord {
    const record = this.findIssue(idOrIdentifier);
    if (record === undefined) throw notFound("Issue");
    return record;
  }

  private toIssue(record: IssueRecord): Issue {
    const team = this.requireTeam(record.teamId);
    const state = this.requireState(record.teamId, record.stateId);
    const identifier = `${team.key}-${record.number}`;
    const slug = slugify(record.title);
    return {
      id: record.id,
      identifier,
      url: `https://linear.app/${URL_KEY}/issue/${identifier}/${slug}`,
      title: record.title,
      description: record.description,
      stateId: state.id,
      stateType: state.type,
      stateName: state.name,
      priority: record.priority,
      estimate: record.estimate,
      labelIds: [...record.labelIds],
      projectId: record.projectId,
      projectMilestoneId: record.projectMilestoneId,
      parentId: record.parentId,
      assigneeId: record.assigneeId,
      dueDate: record.dueDate,
      branchName: `mike/${identifier.toLowerCase()}-${slug}`,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
      canceledAt: record.canceledAt,
    };
  }

  private toProject(record: ProjectRecord): Project {
    return {
      id: record.id,
      slugId: record.slugId,
      url: `https://linear.app/${URL_KEY}/project/${slugify(record.name)}-${record.slugId}`,
      name: record.name,
      icon: record.icon,
      color: record.color,
      description: record.description,
      content: record.content,
      statusId: record.statusId,
      priority: record.priority,
      leadId: record.leadId,
      memberIds: [...record.memberIds],
      labelIds: [...record.labelIds],
      startDate: record.startDate,
      targetDate: record.targetDate,
      teamIds: [...record.teamIds],
      updatedAt: record.updatedAt,
    };
  }
}

function invalid(message: string): LinearError {
  return new LinearError("invalid", message, { code: "INVALID_INPUT" });
}

function notFound(entity: string): LinearError {
  return new LinearError("not_found", `Could not find referenced ${entity}.`, {
    code: "INPUT_ERROR",
  });
}

function checkColor(color: string): void {
  if (!HEX_COLOR.test(color)) throw invalid(MESSAGES.color);
}

function checkIcon(icon: string): void {
  if (!isValidIcon(icon)) throw invalid(MESSAGES.icon);
}

function checkPriority(priority: number): void {
  if (priority > 4) throw invalid(MESSAGES.priority);
  if (priority < 0) throw invalid(MESSAGES.priorityLow);
  if (!Number.isInteger(priority)) {
    throw invalid("priority must be an integer number.");
  }
}

function checkMilestoneName(name: string): void {
  if (name.trim().length < 2) throw invalid(MESSAGES.milestoneName);
}

function toLabel(record: LabelRecord): Label {
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    description: record.description,
    isGroup: record.isGroup,
    parentId: record.parentId,
    teamId: record.teamId,
  };
}

function toComment(record: CommentRecord): Comment {
  return {
    id: record.id,
    issueId: record.issueId,
    body: record.body,
    userId: record.userId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    reactions: record.reactions.map((reaction) => ({ ...reaction })),
  };
}

/** Linear's URL slug: lowercase words joined by hyphens. */
function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 60)
      .replace(/-+$/u, "") || "untitled"
  );
}

interface CursorKey {
  readonly updatedAt: string;
  readonly id: string;
}

function compareByUpdated(left: CursorKey, right: CursorKey): number {
  return (
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function encodeCursor(key: CursorKey): string {
  return Buffer.from(`${key.updatedAt}|${key.id}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): CursorKey {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = text.indexOf("|");
  const updatedAt = text.slice(0, separator);
  if (separator <= 0 || Number.isNaN(Date.parse(updatedAt))) {
    throw invalid("Invalid cursor.");
  }
  return { updatedAt, id: text.slice(separator + 1) };
}
