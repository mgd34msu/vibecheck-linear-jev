// The Linear operations vibecheck-linear-jev uses, as one typed interface.
//
// Two implementations: GraphqlLinearApi (src/linear/graphql.ts) talks to
// https://api.linear.app/graphql with the user's personal API key, and
// MemoryLinearApi (src/linear/memory.ts) keeps everything in memory for tests.
// Everything above this file codes against LinearApi, never against GraphQL.
//
// Facts this interface relies on, checked against Linear on 2026-10-10:
//   - every create input accepts a client-supplied `id`, kept exactly;
//   - project `description` is at most 255 characters (longer text goes in
//     `content`);
//   - `icon` takes a Linear icon name (`Skull`, `Rocket`, `Book`) or an emoji
//     shortcode (`:rocket:`), never a raw emoji;
//   - `color` is a hex color (`#rrggbb`);
//   - one query may cost at most 10,000 complexity points, so lists page;
//   - relation types are blocks, duplicate, related, similar;
//   - project update health is onTrack, atRisk, offTrack;
//   - date resolution is month, quarter, halfYear, year;
//   - label groups are singleSelect or multiSelect.

export type StateType =
  "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

export type RelationType = "blocks" | "duplicate" | "related" | "similar";
export type Health = "onTrack" | "atRisk" | "offTrack";
export type DateResolution = "month" | "quarter" | "halfYear" | "year";
export type LabelGroupType = "singleSelect" | "multiSelect";

/** Calendar date, `YYYY-MM-DD`. */
export type DateOnly = string;
/** ISO 8601 timestamp as Linear returns it. */
export type Timestamp = string;

export interface Viewer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly admin: boolean;
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly urlKey: string;
  };
}

export interface Team {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface WorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: StateType;
  /** Linear's ordering within the team's workflow. */
  readonly position: number;
}

export interface ProjectStatus {
  readonly id: string;
  readonly name: string;
  readonly type:
    "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";
}

export interface Label {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
  readonly isGroup: boolean;
  /** Parent group's id, when the label belongs to a group. */
  readonly parentId: string | null;
  /** Owning team, or null for a workspace label. */
  readonly teamId: string | null;
}

export interface NewLabel {
  readonly id?: string;
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
  readonly isGroup?: boolean;
  readonly groupType?: LabelGroupType;
  readonly parentId?: string;
  /** Omit for a workspace label. */
  readonly teamId?: string;
}

export interface ProjectFields {
  readonly name: string;
  readonly icon?: string;
  readonly color?: string;
  /** At most 255 characters. */
  readonly description?: string;
  /** Full markdown overview. */
  readonly content?: string;
  readonly statusId?: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  readonly priority?: number;
  readonly leadId?: string;
  readonly memberIds?: readonly string[];
  readonly labelIds?: readonly string[];
  readonly startDate?: DateOnly;
  readonly startDateResolution?: DateResolution;
  readonly targetDate?: DateOnly;
  readonly targetDateResolution?: DateResolution;
}

export interface NewProject extends ProjectFields {
  readonly id?: string;
  readonly teamIds: readonly string[];
}

export interface Project extends Required<Pick<ProjectFields, "name">> {
  readonly id: string;
  readonly slugId: string;
  readonly url: string;
  readonly icon: string | null;
  readonly color: string | null;
  readonly description: string;
  readonly content: string;
  readonly statusId: string | null;
  readonly priority: number;
  readonly leadId: string | null;
  readonly memberIds: readonly string[];
  readonly labelIds: readonly string[];
  readonly startDate: DateOnly | null;
  readonly targetDate: DateOnly | null;
  readonly teamIds: readonly string[];
  readonly updatedAt: Timestamp;
}

export interface Milestone {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly targetDate: DateOnly | null;
  readonly sortOrder: number;
}

export interface NewMilestone {
  readonly id?: string;
  readonly projectId: string;
  readonly name: string;
  readonly description?: string;
  readonly targetDate?: DateOnly;
  readonly sortOrder?: number;
}

export interface Document {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly icon: string | null;
  readonly color: string | null;
  readonly content: string;
  readonly updatedAt: Timestamp;
}

export interface NewDocument {
  readonly id?: string;
  readonly projectId: string;
  readonly title: string;
  readonly icon?: string;
  readonly color?: string;
  readonly content?: string;
}

export interface ExternalLink {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export interface IssueFields {
  readonly title?: string;
  readonly description?: string;
  readonly stateId?: string;
  readonly priority?: number;
  readonly estimate?: number | null;
  readonly labelIds?: readonly string[];
  readonly projectMilestoneId?: string | null;
  readonly parentId?: string | null;
  readonly assigneeId?: string | null;
  readonly subscriberIds?: readonly string[];
  readonly dueDate?: DateOnly | null;
  readonly sortOrder?: number;
}

export interface NewIssue extends IssueFields {
  readonly id?: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly title: string;
}

export interface Issue {
  readonly id: string;
  /** e.g. `TA-42`. */
  readonly identifier: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly stateId: string;
  readonly stateType: StateType;
  readonly stateName: string;
  readonly priority: number;
  readonly estimate: number | null;
  readonly labelIds: readonly string[];
  readonly projectId: string | null;
  readonly projectMilestoneId: string | null;
  readonly parentId: string | null;
  readonly assigneeId: string | null;
  readonly dueDate: DateOnly | null;
  readonly branchName: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly completedAt: Timestamp | null;
  readonly canceledAt: Timestamp | null;
}

export interface Relation {
  readonly id: string;
  readonly type: RelationType;
  /** For `blocks`: this issue blocks `relatedIssueId`. */
  readonly issueId: string;
  readonly relatedIssueId: string;
}

export interface Comment {
  readonly id: string;
  readonly issueId: string;
  readonly body: string;
  /** Null when the comment came from an integration rather than a user. */
  readonly userId: string | null;
  /** Server-assigned; claim ordering relies on it. */
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** Emoji reactions, by emoji name (`+1`, `-1`, ...), with the reacting user ids. */
  readonly reactions: readonly {
    readonly emoji: string;
    readonly userId: string | null;
  }[];
}

/** A pull request linked to an issue through Linear's GitHub or GitLab integration. */
export interface LinkedPullRequest {
  readonly url: string;
  readonly title: string;
  readonly source: "github" | "gitlab";
  readonly number: number | null;
  readonly branch: string | null;
  readonly draft: boolean | null;
  readonly createdAt: Timestamp | null;
  readonly closedAt: Timestamp | null;
  readonly mergedAt: Timestamp | null;
  readonly hasConflicts: boolean | null;
}

export interface ProjectUpdate {
  readonly id: string;
  readonly projectId: string;
  readonly health: Health | null;
  readonly body: string;
  readonly createdAt: Timestamp;
}

export interface Page<T> {
  readonly nodes: readonly T[];
  /** Pass back as `after` for the next page; null when this is the last page. */
  readonly next: string | null;
}

export interface IssueFilter {
  readonly projectId: string;
  /** Only issues updated strictly after this time. */
  readonly updatedAfter?: Timestamp;
  /** Include archived issues. Default false. */
  readonly includeArchived?: boolean;
}

/** Rate-limit headroom from the last response's headers. */
export interface RateLimit {
  readonly requestsLimit: number;
  readonly requestsRemaining: number;
  readonly complexityLimit: number;
  readonly complexityRemaining: number;
  /** Epoch milliseconds. */
  readonly resetAt: number;
}

/**
 * Every Linear read and write the tool makes. Implementations throw
 * LinearError (src/linear/errors.ts) for every failure; nothing returns a
 * partial result silently.
 */
export interface LinearApi {
  viewer(): Promise<Viewer>;
  teams(): Promise<readonly Team[]>;
  workflowStates(teamId: string): Promise<readonly WorkflowState[]>;
  projectStatuses(): Promise<readonly ProjectStatus[]>;

  /** Team labels for `teamId` plus every workspace label. */
  labels(teamId: string): Promise<readonly Label[]>;
  createLabel(input: NewLabel): Promise<Label>;

  /** Project labels (Linear's ProjectLabel, separate from issue labels). */
  projectLabels(): Promise<readonly Label[]>;
  createProjectLabel(
    input: Omit<NewLabel, "groupType" | "teamId">,
  ): Promise<Label>;

  project(idOrSlug: string): Promise<Project | null>;
  createProject(input: NewProject): Promise<Project>;
  updateProject(id: string, input: Partial<ProjectFields>): Promise<Project>;
  /** Moves the project to Linear's trash. */
  deleteProject(id: string): Promise<void>;
  /** Projects the viewer can see, by name substring when given. */
  projects(nameContains?: string): Promise<readonly Project[]>;

  milestones(projectId: string): Promise<readonly Milestone[]>;
  createMilestone(input: NewMilestone): Promise<Milestone>;
  updateMilestone(
    id: string,
    input: Partial<Omit<NewMilestone, "id" | "projectId">>,
  ): Promise<Milestone>;

  documents(projectId: string): Promise<readonly Document[]>;
  createDocument(input: NewDocument): Promise<Document>;
  updateDocument(
    id: string,
    input: Partial<Omit<NewDocument, "id" | "projectId">>,
  ): Promise<Document>;

  externalLinks(projectId: string): Promise<readonly ExternalLink[]>;
  createExternalLink(
    projectId: string,
    input: {
      readonly id?: string;
      readonly label: string;
      readonly url: string;
    },
  ): Promise<ExternalLink>;

  /** One page of at most 50 issues, ordered by updatedAt ascending. */
  issues(filter: IssueFilter, after?: string): Promise<Page<Issue>>;
  issue(idOrIdentifier: string): Promise<Issue | null>;
  createIssue(input: NewIssue): Promise<Issue>;
  updateIssue(id: string, input: IssueFields): Promise<Issue>;
  addLabel(issueId: string, labelId: string): Promise<void>;
  removeLabel(issueId: string, labelId: string): Promise<void>;

  /** Relations where the issue is either side. */
  relations(issueId: string): Promise<readonly Relation[]>;
  createRelation(input: {
    readonly id?: string;
    readonly type: RelationType;
    readonly issueId: string;
    readonly relatedIssueId: string;
  }): Promise<Relation>;
  deleteRelation(id: string): Promise<void>;

  /** Comments on an issue, oldest first, all pages. */
  comments(issueId: string): Promise<readonly Comment[]>;
  createComment(input: {
    readonly id?: string;
    readonly issueId: string;
    readonly body: string;
  }): Promise<Comment>;
  updateComment(id: string, body: string): Promise<Comment>;
  deleteComment(id: string): Promise<void>;

  /** Pull requests linked to the issue; empty when the workspace has no Git integration. */
  pullRequests(issueId: string): Promise<readonly LinkedPullRequest[]>;

  projectUpdates(projectId: string): Promise<readonly ProjectUpdate[]>;
  createProjectUpdate(input: {
    readonly id?: string;
    readonly projectId: string;
    readonly body: string;
    readonly health?: Health;
  }): Promise<ProjectUpdate>;

  /** Headroom from the most recent response, when the server sent it. */
  rateLimit(): RateLimit | null;
}
