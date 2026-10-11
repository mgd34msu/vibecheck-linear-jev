// GraphqlLinearApi: LinearApi over Linear's public GraphQL endpoint.
//
// Plain fetch POSTs to https://api.linear.app/graphql with a personal API key
// sent bare in the Authorization header (personal keys take no "Bearer").
// Every query is written by hand and asks for exactly the fields api.ts
// needs; every response is validated with zod before it is mapped. Lists page
// 50 nodes at a time and nested connections stay small, so no single query
// approaches Linear's 10,000-point complexity cap.
//
// Failures throw LinearError (errors.ts). Network and server failures get one
// retry after a short pause; rate limits are thrown straight back so the
// caller's outbox decides when to try again. A create that carried a client id
// and whose first attempt failed in transit may already exist when retried;
// the retry then reads the existing object back instead of failing.

import { z } from "zod";
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
  StateType,
  Team,
  Viewer,
  WorkflowState,
} from "./api.js";
import {
  errorFromGraphql,
  errorFromHttp,
  graphqlErrorSchema,
  isLinearError,
  LinearError,
  removeLabelIfPresent,
} from "./errors.js";

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

/** Nodes per page for every list query. */
export const PAGE_SIZE = 50;

/** The subset of `fetch` this client calls. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GraphqlLinearApiOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetch?: FetchLike;
  /** Per-request timeout. Default 30 seconds. */
  readonly timeoutMs?: number;
  /** Pause before the single retry of a network or server failure. Default 500 ms. */
  readonly retryDelayMs?: number;
  /** Clock for rate-limit arithmetic, epoch milliseconds. */
  readonly now?: () => number;
}

type Variables = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Response schemas. Each maps Linear's shape to the api.ts shape.

const idRef = z.object({ id: z.string() });
const nullableId = idRef.nullable().transform((value) => value?.id ?? null);

function connection<T extends z.ZodType>(node: T) {
  return z.object({
    nodes: z.array(node),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  });
}

const idNodes = z
  .object({ nodes: z.array(idRef) })
  .transform((value) => value.nodes.map((node) => node.id));

/**
 * Linear's state types. TA's `Duplicate` state reports type `duplicate`,
 * which api.ts folds into `canceled` (Linear files it under Canceled).
 */
const stateType = z
  .enum([
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "duplicate",
  ])
  .transform((type): StateType => (type === "duplicate" ? "canceled" : type));

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

const VIEWER_FIELDS = "id name email admin organization { id name urlKey }";
const viewerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  admin: z.boolean(),
  organization: z.object({
    id: z.string(),
    name: z.string(),
    urlKey: z.string(),
  }),
});

const TEAM_FIELDS = "id key name";
const teamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});

const STATE_FIELDS = "id name type position";
const stateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: stateType,
  position: z.number(),
});

const PROJECT_STATUS_FIELDS = "id name type";
const projectStatusSchema = z.object({
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
});

const LABEL_FIELDS =
  "id name color description isGroup parent { id } team { id }";
const labelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    description: z.string().nullable(),
    isGroup: z.boolean(),
    parent: nullableId,
    team: nullableId,
  })
  .transform((raw): Label => ({
    id: raw.id,
    name: raw.name,
    color: raw.color,
    description: raw.description,
    isGroup: raw.isGroup,
    parentId: raw.parent,
    teamId: raw.team,
  }));

/** Project labels have the issue label's fields except the team. */
const PROJECT_LABEL_FIELDS = "id name color description isGroup parent { id }";
const projectLabelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    description: z.string().nullable(),
    isGroup: z.boolean(),
    parent: nullableId,
  })
  .transform((raw): Label => ({
    id: raw.id,
    name: raw.name,
    color: raw.color,
    description: raw.description,
    isGroup: raw.isGroup,
    parentId: raw.parent,
    teamId: null,
  }));

const PROJECT_FIELDS = `id slugId url name icon color description content
  status { id } priority lead { id } members(first: 50) { nodes { id } }
  labelIds startDate targetDate teams(first: 25) { nodes { id } } updatedAt`;
const projectSchema = z
  .object({
    id: z.string(),
    slugId: z.string(),
    url: z.string(),
    name: z.string(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    description: z.string().nullable(),
    content: z.string().nullable(),
    status: nullableId,
    priority: z.number(),
    lead: nullableId,
    members: idNodes,
    labelIds: z.array(z.string()),
    startDate: z.string().nullable(),
    targetDate: z.string().nullable(),
    teams: idNodes,
    updatedAt: z.string(),
  })
  .transform((raw): Project => ({
    id: raw.id,
    slugId: raw.slugId,
    url: raw.url,
    name: raw.name,
    icon: raw.icon,
    color: raw.color,
    description: raw.description ?? "",
    content: raw.content ?? "",
    statusId: raw.status,
    priority: raw.priority,
    leadId: raw.lead,
    memberIds: raw.members,
    labelIds: raw.labelIds,
    startDate: raw.startDate,
    targetDate: raw.targetDate,
    teamIds: raw.teams,
    updatedAt: raw.updatedAt,
  }));

const MILESTONE_FIELDS =
  "id name description targetDate sortOrder project { id }";
const milestoneSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    targetDate: z.string().nullable(),
    sortOrder: z.number(),
    project: idRef,
  })
  .transform((raw): Milestone => ({
    id: raw.id,
    projectId: raw.project.id,
    name: raw.name,
    description: raw.description ?? "",
    targetDate: raw.targetDate,
    sortOrder: raw.sortOrder,
  }));

const DOCUMENT_FIELDS = "id title icon color content updatedAt project { id }";
const documentSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    content: z.string().nullable(),
    updatedAt: z.string(),
    project: nullableId,
  })
  .transform((raw): Document => ({
    id: raw.id,
    projectId: raw.project,
    title: raw.title,
    icon: raw.icon,
    color: raw.color,
    content: raw.content ?? "",
    updatedAt: raw.updatedAt,
  }));

const LINK_FIELDS = "id label url";
const linkSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
});

const ISSUE_FIELDS = `id identifier url title description priority estimate
  labelIds project { id } projectMilestone { id } parent { id } assignee { id }
  dueDate branchName createdAt updatedAt completedAt canceledAt
  state { id name type }`;
const issueSchema = z
  .object({
    id: z.string(),
    identifier: z.string(),
    url: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    priority: z.number(),
    estimate: z.number().nullable(),
    labelIds: z.array(z.string()),
    project: nullableId,
    projectMilestone: nullableId,
    parent: nullableId,
    assignee: nullableId,
    dueDate: z.string().nullable(),
    branchName: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
    canceledAt: z.string().nullable(),
    state: z.object({ id: z.string(), name: z.string(), type: stateType }),
  })
  .transform((raw): Issue => ({
    id: raw.id,
    identifier: raw.identifier,
    url: raw.url,
    title: raw.title,
    description: raw.description ?? "",
    stateId: raw.state.id,
    stateType: raw.state.type,
    stateName: raw.state.name,
    priority: raw.priority,
    estimate: raw.estimate,
    labelIds: raw.labelIds,
    projectId: raw.project,
    projectMilestoneId: raw.projectMilestone,
    parentId: raw.parent,
    assigneeId: raw.assignee,
    dueDate: raw.dueDate,
    branchName: raw.branchName,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    completedAt: raw.completedAt,
    canceledAt: raw.canceledAt,
  }));

const RELATION_FIELDS = "id type issue { id } relatedIssue { id }";
const relationSchema = z
  .object({
    id: z.string(),
    type: z.enum(["blocks", "duplicate", "related", "similar"]),
    issue: idRef,
    relatedIssue: idRef,
  })
  .transform((raw): Relation => ({
    id: raw.id,
    type: raw.type,
    issueId: raw.issue.id,
    relatedIssueId: raw.relatedIssue.id,
  }));

const COMMENT_FIELDS = `id body createdAt updatedAt user { id } issue { id }
  reactions { emoji user { id } }`;
const commentSchema = z
  .object({
    id: z.string(),
    body: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    user: nullableId,
    issue: nullableId,
    reactions: z.array(
      z.object({ emoji: z.string(), user: nullableId }).nullable(),
    ),
  })
  .transform((raw): Comment => ({
    id: raw.id,
    issueId: raw.issue ?? "",
    body: raw.body,
    userId: raw.user,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reactions: raw.reactions.flatMap((reaction) =>
      reaction === null
        ? []
        : [{ emoji: reaction.emoji, userId: reaction.user }],
    ),
  }));

const ATTACHMENT_FIELDS = "id title url sourceType metadata";
const attachmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  sourceType: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

/** Pull-request metadata keys Linear's GitHub and GitLab integrations write. */
const pullRequestMetadataSchema = z.object({
  number: z.number().nullable().optional().catch(null),
  branch: z.string().nullable().optional().catch(null),
  draft: z.boolean().nullable().optional().catch(null),
  createdAt: z.string().nullable().optional().catch(null),
  closedAt: z.string().nullable().optional().catch(null),
  mergedAt: z.string().nullable().optional().catch(null),
  hasConflicts: z.boolean().nullable().optional().catch(null),
});

const PROJECT_UPDATE_FIELDS = "id body health createdAt project { id }";
const projectUpdateSchema = z
  .object({
    id: z.string(),
    body: z.string(),
    health: z.enum(["onTrack", "atRisk", "offTrack"]).nullable(),
    createdAt: z.string(),
    project: idRef,
  })
  .transform((raw): ProjectUpdate => ({
    id: raw.id,
    projectId: raw.project.id,
    health: raw.health,
    body: raw.body,
    createdAt: raw.createdAt,
  }));

const successSchema = z.object({ success: z.boolean() });

const responseSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(graphqlErrorSchema).optional(),
});

const trashedSchema = z.object({ trashed: z.boolean().nullable() });

function withoutTrashed(
  project: Project & { readonly trashed: boolean | null },
): Project {
  const { trashed: _trashed, ...rest } = project;
  return rest;
}

/** Linear's response headers carrying rate-limit headroom. */
function rateLimitFromHeaders(headers: Headers): RateLimit | null {
  const read = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const requestsLimit = read("x-ratelimit-requests-limit");
  const requestsRemaining = read("x-ratelimit-requests-remaining");
  const complexityLimit = read("x-ratelimit-complexity-limit");
  const complexityRemaining = read("x-ratelimit-complexity-remaining");
  const requestsReset = read("x-ratelimit-requests-reset");
  const complexityReset = read("x-ratelimit-complexity-reset");
  if (
    requestsLimit === null ||
    requestsRemaining === null ||
    complexityLimit === null ||
    complexityRemaining === null
  ) {
    return null;
  }
  return {
    requestsLimit,
    requestsRemaining,
    complexityLimit,
    complexityRemaining,
    resetAt: Math.max(requestsReset ?? 0, complexityReset ?? 0),
  };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** LinearApi against Linear's GraphQL API with a personal API key. */
export class GraphqlLinearApi implements LinearApi {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private lastRateLimit: RateLimit | null = null;
  private lastComplexityValue: number | null = null;

  constructor(options: GraphqlLinearApiOptions) {
    if (options.apiKey.trim() === "") {
      throw new LinearError("auth", "No Linear API key was given.");
    }
    this.apiKey = options.apiKey.trim();
    this.endpoint = options.endpoint ?? LINEAR_ENDPOINT;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.now = options.now ?? Date.now;
  }

  rateLimit(): RateLimit | null {
    return this.lastRateLimit;
  }

  /** Complexity points Linear charged for the most recent query (`x-complexity`). */
  lastComplexity(): number | null {
    return this.lastComplexityValue;
  }

  // -------------------------------------------------------------------------
  // Transport

  private async send(query: string, variables: Variables): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      const message = controller.signal.aborted
        ? `Linear did not respond within ${this.timeoutMs} ms.`
        : `Could not reach Linear: ${describe(error)}`;
      throw new LinearError("network", message, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    const rateLimit = rateLimitFromHeaders(response.headers);
    if (rateLimit !== null) this.lastRateLimit = rateLimit;
    const complexity = Number(response.headers.get("x-complexity") ?? "");
    this.lastComplexityValue =
      Number.isFinite(complexity) && complexity > 0 ? complexity : null;

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw response.ok
        ? new LinearError(
            "server",
            "Linear returned a response that is not JSON.",
            {
              status: response.status,
            },
          )
        : errorFromHttp(response.status, response.headers, this.now(), text);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw response.ok
        ? new LinearError(
            "server",
            "Linear returned an unrecognised response.",
            {
              status: response.status,
            },
          )
        : errorFromHttp(response.status, response.headers, this.now(), text);
    }
    const errors = parsed.data.errors ?? [];
    if (errors.length > 0) {
      throw errorFromGraphql(
        errors,
        response.status,
        response.headers,
        this.now(),
      );
    }
    if (!response.ok) {
      throw errorFromHttp(response.status, response.headers, this.now(), text);
    }
    if (parsed.data.data === undefined || parsed.data.data === null) {
      throw new LinearError("server", "Linear returned no data.", {
        status: response.status,
      });
    }
    return parsed.data.data;
  }

  /**
   * Runs one operation with a single retry for network and server failures.
   * `recover` reads back a create whose first attempt may have landed.
   */
  private async request<T extends z.ZodType>(
    query: string,
    variables: Variables,
    schema: T,
    recover?: () => Promise<z.output<T>>,
  ): Promise<z.output<T>> {
    let data: unknown;
    try {
      data = await this.send(query, variables);
    } catch (error) {
      if (!isLinearError(error, "network", "server")) throw error;
      await pause(this.retryDelayMs);
      try {
        data = await this.send(query, variables);
      } catch (retryError) {
        if (
          recover !== undefined &&
          isLinearError(retryError, "invalid") &&
          /already exists/iu.test(retryError.message)
        ) {
          return recover();
        }
        throw retryError;
      }
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new LinearError(
        "server",
        `Linear's response did not have the expected shape: ${result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  /** Reads every page of a connection, `PAGE_SIZE` nodes at a time. */
  private async allPages<T extends z.ZodType>(
    query: string,
    variables: Variables,
    node: T,
    pick: (data: unknown) => unknown,
  ): Promise<z.output<T>[]> {
    const page = connection(node);
    const pageSchema = z.unknown().transform((data, context) => {
      const picked = page.safeParse(pick(data));
      if (!picked.success) {
        context.addIssue({
          code: "custom",
          message: picked.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
        return z.NEVER;
      }
      return picked.data;
    });
    const nodes: z.output<T>[] = [];
    let after: string | null = null;
    for (;;) {
      const result: z.output<typeof pageSchema> = await this.request(
        query,
        { ...variables, first: PAGE_SIZE, after },
        pageSchema,
      );
      nodes.push(...result.nodes);
      if (!result.pageInfo.hasNextPage || result.pageInfo.endCursor === null) {
        return nodes;
      }
      after = result.pageInfo.endCursor;
    }
  }

  /** Runs a lookup that maps Linear's "Entity not found" to null. */
  private async orNull<T>(lookup: () => Promise<T>): Promise<T | null> {
    try {
      return await lookup();
    } catch (error) {
      if (isLinearError(error, "not_found")) return null;
      throw error;
    }
  }

  private async mutateSuccess(
    query: string,
    variables: Variables,
    field: string,
  ): Promise<void> {
    const result = await this.request(
      query,
      variables,
      z.object({ [field]: successSchema }),
    );
    const payload = result[field];
    if (payload?.success !== true) {
      throw new LinearError(
        "server",
        `Linear reported ${field} did not succeed.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Workspace

  async viewer(): Promise<Viewer> {
    const result = await this.request(
      `query Viewer { viewer { ${VIEWER_FIELDS} } }`,
      {},
      z.object({ viewer: viewerSchema }),
    );
    return result.viewer;
  }

  async teams(): Promise<readonly Team[]> {
    return this.allPages(
      `query Teams($first: Int!, $after: String) {
        teams(first: $first, after: $after) { nodes { ${TEAM_FIELDS} } ${PAGE_INFO} }
      }`,
      {},
      teamSchema,
      (data) => pickPath(data, "teams"),
    );
  }

  async workflowStates(teamId: string): Promise<readonly WorkflowState[]> {
    const states = await this.allPages(
      `query States($teamId: ID!, $first: Int!, $after: String) {
        workflowStates(first: $first, after: $after, filter: { team: { id: { eq: $teamId } } }) {
          nodes { ${STATE_FIELDS} } ${PAGE_INFO}
        }
      }`,
      { teamId },
      stateSchema,
      (data) => pickPath(data, "workflowStates"),
    );
    return states.sort((left, right) => left.position - right.position);
  }

  async projectStatuses(): Promise<readonly ProjectStatus[]> {
    return this.allPages(
      `query ProjectStatuses($first: Int!, $after: String) {
        projectStatuses(first: $first, after: $after) { nodes { ${PROJECT_STATUS_FIELDS} } ${PAGE_INFO} }
      }`,
      {},
      projectStatusSchema,
      (data) => pickPath(data, "projectStatuses"),
    );
  }

  async labels(teamId: string): Promise<readonly Label[]> {
    return this.allPages(
      `query Labels($teamId: ID!, $first: Int!, $after: String) {
        issueLabels(first: $first, after: $after,
          filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) {
          nodes { ${LABEL_FIELDS} } ${PAGE_INFO}
        }
      }`,
      { teamId },
      labelSchema,
      (data) => pickPath(data, "issueLabels"),
    );
  }

  async createLabel(input: NewLabel): Promise<Label> {
    const result = await this.request(
      `mutation CreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { issueLabel { ${LABEL_FIELDS} } }
      }`,
      { input },
      z.object({ issueLabelCreate: z.object({ issueLabel: labelSchema }) }),
      this.recoverWith(input.id, async (id) => ({
        issueLabelCreate: { issueLabel: await this.label(id) },
      })),
    );
    return result.issueLabelCreate.issueLabel;
  }

  async projectLabels(): Promise<readonly Label[]> {
    return this.allPages(
      `query ProjectLabels($first: Int!, $after: String) {
        projectLabels(first: $first, after: $after) {
          nodes { ${PROJECT_LABEL_FIELDS} } ${PAGE_INFO}
        }
      }`,
      {},
      projectLabelSchema,
      (data) => pickPath(data, "projectLabels"),
    );
  }

  async createProjectLabel(
    input: Omit<NewLabel, "groupType" | "teamId">,
  ): Promise<Label> {
    const result = await this.request(
      `mutation CreateProjectLabel($input: ProjectLabelCreateInput!) {
        projectLabelCreate(input: $input) { projectLabel { ${PROJECT_LABEL_FIELDS} } }
      }`,
      { input },
      z.object({
        projectLabelCreate: z.object({ projectLabel: projectLabelSchema }),
      }),
      this.recoverWith(input.id, async (id) => ({
        projectLabelCreate: { projectLabel: await this.projectLabel(id) },
      })),
    );
    return result.projectLabelCreate.projectLabel;
  }

  /** One project label by id. Not part of LinearApi; used for retry recovery. */
  async projectLabel(id: string): Promise<Label> {
    const result = await this.request(
      `query ProjectLabel($id: String!) { projectLabel(id: $id) { ${PROJECT_LABEL_FIELDS} } }`,
      { id },
      z.object({ projectLabel: projectLabelSchema }),
    );
    return result.projectLabel;
  }

  /** Deletes a project label. Not part of LinearApi; tests use it to clean up. */
  async deleteProjectLabel(id: string): Promise<void> {
    await this.mutateSuccess(
      `mutation DeleteProjectLabel($id: String!) { projectLabelDelete(id: $id) { success } }`,
      { id },
      "projectLabelDelete",
    );
  }

  /** One label by id. Not part of LinearApi; used for retry recovery. */
  async label(id: string): Promise<Label> {
    const result = await this.request(
      `query Label($id: String!) { issueLabel(id: $id) { ${LABEL_FIELDS} } }`,
      { id },
      z.object({ issueLabel: labelSchema }),
    );
    return result.issueLabel;
  }

  /** Deletes a label. Not part of LinearApi; tests use it to clean up. */
  async deleteLabel(id: string): Promise<void> {
    await this.mutateSuccess(
      `mutation DeleteLabel($id: String!) { issueLabelDelete(id: $id) { success } }`,
      { id },
      "issueLabelDelete",
    );
  }

  // -------------------------------------------------------------------------
  // Projects

  /** Accepts a project UUID or slug ID; a trashed project reads as null. */
  async project(idOrSlug: string): Promise<Project | null> {
    const found = await this.orNull(() =>
      this.request(
        `query Project($id: String!) { project(id: $id) { ${PROJECT_FIELDS} trashed } }`,
        { id: idOrSlug },
        z.object({ project: projectSchema.and(trashedSchema) }),
      ),
    );
    if (found === null || found.project.trashed === true) return null;
    return withoutTrashed(found.project);
  }

  async createProject(input: NewProject): Promise<Project> {
    const result = await this.request(
      `mutation CreateProject($input: ProjectCreateInput!) {
        projectCreate(input: $input) { project { ${PROJECT_FIELDS} } }
      }`,
      { input },
      z.object({ projectCreate: z.object({ project: projectSchema }) }),
      this.recoverWith(input.id, async (id) => ({
        projectCreate: { project: await this.requireProject(id) },
      })),
    );
    return result.projectCreate.project;
  }

  async updateProject(
    id: string,
    input: Partial<ProjectFields>,
  ): Promise<Project> {
    const result = await this.request(
      `mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) { project { ${PROJECT_FIELDS} } }
      }`,
      { id, input },
      z.object({ projectUpdate: z.object({ project: projectSchema }) }),
    );
    return result.projectUpdate.project;
  }

  async deleteProject(id: string): Promise<void> {
    await this.mutateSuccess(
      `mutation DeleteProject($id: String!) { projectDelete(id: $id) { success } }`,
      { id },
      "projectDelete",
    );
  }

  async projects(nameContains?: string): Promise<readonly Project[]> {
    return this.allPages(
      `query Projects($filter: ProjectFilter, $first: Int!, $after: String) {
        projects(first: $first, after: $after, filter: $filter) {
          nodes { ${PROJECT_FIELDS} } ${PAGE_INFO}
        }
      }`,
      {
        filter:
          nameContains === undefined || nameContains === ""
            ? null
            : { name: { containsIgnoreCase: nameContains } },
      },
      projectSchema,
      (data) => pickPath(data, "projects"),
    );
  }

  private async requireProject(id: string): Promise<Project> {
    const project = await this.project(id);
    if (project === null) {
      throw new LinearError("not_found", `Project ${id} was not found.`);
    }
    return project;
  }

  // -------------------------------------------------------------------------
  // Milestones, documents, links

  async milestones(projectId: string): Promise<readonly Milestone[]> {
    const milestones = await this.allPages(
      `query Milestones($projectId: ID!, $first: Int!, $after: String) {
        projectMilestones(first: $first, after: $after,
          filter: { project: { id: { eq: $projectId } } }) {
          nodes { ${MILESTONE_FIELDS} } ${PAGE_INFO}
        }
      }`,
      { projectId },
      milestoneSchema,
      (data) => pickPath(data, "projectMilestones"),
    );
    return milestones.sort((left, right) => left.sortOrder - right.sortOrder);
  }

  async createMilestone(input: NewMilestone): Promise<Milestone> {
    const result = await this.request(
      `mutation CreateMilestone($input: ProjectMilestoneCreateInput!) {
        projectMilestoneCreate(input: $input) { projectMilestone { ${MILESTONE_FIELDS} } }
      }`,
      { input },
      z.object({
        projectMilestoneCreate: z.object({ projectMilestone: milestoneSchema }),
      }),
      this.recoverWith(input.id, async (id) => {
        const found = await this.request(
          `query Milestone($id: String!) { projectMilestone(id: $id) { ${MILESTONE_FIELDS} } }`,
          { id },
          z.object({ projectMilestone: milestoneSchema }),
        );
        return {
          projectMilestoneCreate: { projectMilestone: found.projectMilestone },
        };
      }),
    );
    return result.projectMilestoneCreate.projectMilestone;
  }

  async updateMilestone(
    id: string,
    input: Partial<Omit<NewMilestone, "id" | "projectId">>,
  ): Promise<Milestone> {
    const result = await this.request(
      `mutation UpdateMilestone($id: String!, $input: ProjectMilestoneUpdateInput!) {
        projectMilestoneUpdate(id: $id, input: $input) { projectMilestone { ${MILESTONE_FIELDS} } }
      }`,
      { id, input },
      z.object({
        projectMilestoneUpdate: z.object({ projectMilestone: milestoneSchema }),
      }),
    );
    return result.projectMilestoneUpdate.projectMilestone;
  }

  async documents(projectId: string): Promise<readonly Document[]> {
    return this.allPages(
      `query Documents($projectId: ID!, $first: Int!, $after: String) {
        documents(first: $first, after: $after,
          filter: { project: { id: { eq: $projectId } } }) {
          nodes { ${DOCUMENT_FIELDS} } ${PAGE_INFO}
        }
      }`,
      { projectId },
      documentSchema,
      (data) => pickPath(data, "documents"),
    );
  }

  async createDocument(input: NewDocument): Promise<Document> {
    const result = await this.request(
      `mutation CreateDocument($input: DocumentCreateInput!) {
        documentCreate(input: $input) { document { ${DOCUMENT_FIELDS} } }
      }`,
      { input },
      z.object({ documentCreate: z.object({ document: documentSchema }) }),
      this.recoverWith(input.id, async (id) => {
        const found = await this.request(
          `query Document($id: String!) { document(id: $id) { ${DOCUMENT_FIELDS} } }`,
          { id },
          z.object({ document: documentSchema }),
        );
        return { documentCreate: { document: found.document } };
      }),
    );
    return result.documentCreate.document;
  }

  async updateDocument(
    id: string,
    input: Partial<Omit<NewDocument, "id" | "projectId">>,
  ): Promise<Document> {
    const result = await this.request(
      `mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!) {
        documentUpdate(id: $id, input: $input) { document { ${DOCUMENT_FIELDS} } }
      }`,
      { id, input },
      z.object({ documentUpdate: z.object({ document: documentSchema }) }),
    );
    return result.documentUpdate.document;
  }

  async externalLinks(projectId: string): Promise<readonly ExternalLink[]> {
    return this.allPages(
      `query Links($projectId: String!, $first: Int!, $after: String) {
        project(id: $projectId) {
          externalLinks(first: $first, after: $after) { nodes { ${LINK_FIELDS} } ${PAGE_INFO} }
        }
      }`,
      { projectId },
      linkSchema,
      (data) => pickPath(data, "project", "externalLinks"),
    );
  }

  async createExternalLink(
    projectId: string,
    input: {
      readonly id?: string;
      readonly label: string;
      readonly url: string;
    },
  ): Promise<ExternalLink> {
    const result = await this.request(
      `mutation CreateLink($input: EntityExternalLinkCreateInput!) {
        entityExternalLinkCreate(input: $input) { entityExternalLink { ${LINK_FIELDS} } }
      }`,
      { input: { ...input, projectId } },
      z.object({
        entityExternalLinkCreate: z.object({ entityExternalLink: linkSchema }),
      }),
      this.recoverWith(input.id, async (id) => {
        const found = await this.request(
          `query Link($id: String!) { entityExternalLink(id: $id) { ${LINK_FIELDS} } }`,
          { id },
          z.object({ entityExternalLink: linkSchema }),
        );
        return {
          entityExternalLinkCreate: {
            entityExternalLink: found.entityExternalLink,
          },
        };
      }),
    );
    return result.entityExternalLinkCreate.entityExternalLink;
  }

  // -------------------------------------------------------------------------
  // Issues

  async issues(filter: IssueFilter, after?: string): Promise<Page<Issue>> {
    const issueFilter = {
      project: { id: { eq: filter.projectId } },
      ...(filter.updatedAfter === undefined
        ? {}
        : { updatedAt: { gt: filter.updatedAfter } }),
    };
    const result = await this.request(
      `query Issues($filter: IssueFilter!, $includeArchived: Boolean!, $first: Int!, $after: String) {
        issues(first: $first, after: $after, filter: $filter, includeArchived: $includeArchived,
          sort: [{ updatedAt: { order: Ascending } }]) {
          nodes { ${ISSUE_FIELDS} } ${PAGE_INFO}
        }
      }`,
      {
        filter: issueFilter,
        includeArchived: filter.includeArchived ?? false,
        first: PAGE_SIZE,
        after: after ?? null,
      },
      z.object({ issues: connection(issueSchema) }),
    );
    const { nodes, pageInfo } = result.issues;
    return {
      nodes,
      next: pageInfo.hasNextPage ? pageInfo.endCursor : null,
    };
  }

  async issue(idOrIdentifier: string): Promise<Issue | null> {
    return this.orNull(async () => {
      const result = await this.request(
        `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id: idOrIdentifier },
        z.object({ issue: issueSchema }),
      );
      return result.issue;
    });
  }

  async createIssue(input: NewIssue): Promise<Issue> {
    const result = await this.request(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } }
      }`,
      { input },
      z.object({ issueCreate: z.object({ issue: issueSchema }) }),
      this.recoverWith(input.id, async (id) => ({
        issueCreate: { issue: await this.requireIssue(id) },
      })),
    );
    return result.issueCreate.issue;
  }

  async updateIssue(id: string, input: IssueFields): Promise<Issue> {
    const result = await this.request(
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } }
      }`,
      { id, input },
      z.object({ issueUpdate: z.object({ issue: issueSchema }) }),
    );
    return result.issueUpdate.issue;
  }

  async addLabel(issueId: string, labelId: string): Promise<void> {
    await this.mutateSuccess(
      `mutation AddLabel($id: String!, $labelId: String!) {
        issueAddLabel(id: $id, labelId: $labelId) { success }
      }`,
      { id: issueId, labelId },
      "issueAddLabel",
    );
  }

  /**
   * Removes a label; Linear's refusal for a label the issue does not carry
   * ("Label <id> is not on issue <id> and cannot be removed.") counts as done.
   */
  async removeLabel(issueId: string, labelId: string): Promise<void> {
    await removeLabelIfPresent(
      {
        removeLabel: (issue, label) => this.sendRemoveLabel(issue, label),
      },
      issueId,
      labelId,
    );
  }

  /**
   * Removes a label and lets every refusal through, "not on issue" included.
   * Not part of LinearApi; the live contract uses it to check the exact
   * message Linear sends.
   */
  async sendRemoveLabel(issueId: string, labelId: string): Promise<void> {
    await this.mutateSuccess(
      `mutation RemoveLabel($id: String!, $labelId: String!) {
        issueRemoveLabel(id: $id, labelId: $labelId) { success }
      }`,
      { id: issueId, labelId },
      "issueRemoveLabel",
    );
  }

  /** Moves an issue to Linear's trash. Not part of LinearApi; tests use it to clean up. */
  async deleteIssue(id: string): Promise<void> {
    await this.mutateSuccess(
      `mutation DeleteIssue($id: String!) { issueDelete(id: $id) { success } }`,
      { id },
      "issueDelete",
    );
  }

  private async requireIssue(id: string): Promise<Issue> {
    const issue = await this.issue(id);
    if (issue === null) {
      throw new LinearError("not_found", `Issue ${id} was not found.`);
    }
    return issue;
  }

  // -------------------------------------------------------------------------
  // Relations

  async relations(issueId: string): Promise<readonly Relation[]> {
    const [outgoing, incoming] = await Promise.all(
      (["relations", "inverseRelations"] satisfies readonly string[]).map(
        (field) =>
          this.allPages(
            `query Relations($id: String!, $first: Int!, $after: String) {
              issue(id: $id) {
                ${field}(first: $first, after: $after) { nodes { ${RELATION_FIELDS} } ${PAGE_INFO} }
              }
            }`,
            { id: issueId },
            relationSchema,
            (data) => pickPath(data, "issue", field),
          ),
      ),
    );
    const seen = new Set<string>();
    const relations: Relation[] = [];
    for (const relation of [...(outgoing ?? []), ...(incoming ?? [])]) {
      if (seen.has(relation.id)) continue;
      seen.add(relation.id);
      relations.push(relation);
    }
    return relations;
  }

  async createRelation(input: {
    readonly id?: string;
    readonly type: RelationType;
    readonly issueId: string;
    readonly relatedIssueId: string;
  }): Promise<Relation> {
    const result = await this.request(
      `mutation CreateRelation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { issueRelation { ${RELATION_FIELDS} } }
      }`,
      { input },
      z.object({
        issueRelationCreate: z.object({ issueRelation: relationSchema }),
      }),
      this.recoverWith(input.id, async (id) => {
        const found = await this.request(
          `query Relation($id: String!) { issueRelation(id: $id) { ${RELATION_FIELDS} } }`,
          { id },
          z.object({ issueRelation: relationSchema }),
        );
        return { issueRelationCreate: { issueRelation: found.issueRelation } };
      }),
    );
    return result.issueRelationCreate.issueRelation;
  }

  async deleteRelation(id: string): Promise<void> {
    await this.mutateSuccess(
      `mutation DeleteRelation($id: String!) { issueRelationDelete(id: $id) { success } }`,
      { id },
      "issueRelationDelete",
    );
  }

  // -------------------------------------------------------------------------
  // Comments

  async comments(issueId: string): Promise<readonly Comment[]> {
    const comments = await this.allPages(
      `query Comments($id: String!, $first: Int!, $after: String) {
        issue(id: $id) {
          comments(first: $first, after: $after) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} }
        }
      }`,
      { id: issueId },
      commentSchema,
      (data) => pickPath(data, "issue", "comments"),
    );
    return comments
      .map((comment) => ({ ...comment, issueId: comment.issueId || issueId }))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async createComment(input: {
    readonly id?: string;
    readonly issueId: string;
    readonly body: string;
  }): Promise<Comment> {
    const result = await this.request(
      `mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { comment { ${COMMENT_FIELDS} } }
      }`,
      { input },
      z.object({ commentCreate: z.object({ comment: commentSchema }) }),
      this.recoverWith(input.id, async (id) => ({
        commentCreate: { comment: await this.comment(id) },
      })),
    );
    return result.commentCreate.comment;
  }

  /** One comment by id. Not part of LinearApi; used for retry recovery. */
  async comment(id: string): Promise<Comment> {
    const result = await this.request(
      `query Comment($id: String!) { comment(id: $id) { ${COMMENT_FIELDS} } }`,
      { id },
      z.object({ comment: commentSchema }),
    );
    return result.comment;
  }

  async updateComment(id: string, body: string): Promise<Comment> {
    const result = await this.request(
      `mutation UpdateComment($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) { comment { ${COMMENT_FIELDS} } }
      }`,
      { id, input: { body } },
      z.object({ commentUpdate: z.object({ comment: commentSchema }) }),
    );
    return result.commentUpdate.comment;
  }

  async deleteComment(id: string): Promise<void> {
    await this.mutateSuccess(
      `mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`,
      { id },
      "commentDelete",
    );
  }

  // -------------------------------------------------------------------------
  // Pull requests, project updates

  async pullRequests(issueId: string): Promise<readonly LinkedPullRequest[]> {
    const attachments = await this.allPages(
      `query Attachments($id: String!, $first: Int!, $after: String) {
        issue(id: $id) {
          attachments(first: $first, after: $after) { nodes { ${ATTACHMENT_FIELDS} } ${PAGE_INFO} }
        }
      }`,
      { id: issueId },
      attachmentSchema,
      (data) => pickPath(data, "issue", "attachments"),
    );
    return attachments.flatMap((attachment): LinkedPullRequest[] => {
      const source = attachment.sourceType;
      if (source !== "github" && source !== "gitlab") return [];
      const metadata = pullRequestMetadataSchema.parse(attachment.metadata);
      return [
        {
          url: attachment.url,
          title: attachment.title,
          source,
          number: metadata.number ?? null,
          branch: metadata.branch ?? null,
          draft: metadata.draft ?? null,
          createdAt: metadata.createdAt ?? null,
          closedAt: metadata.closedAt ?? null,
          mergedAt: metadata.mergedAt ?? null,
          hasConflicts: metadata.hasConflicts ?? null,
        },
      ];
    });
  }

  async projectUpdates(projectId: string): Promise<readonly ProjectUpdate[]> {
    const updates = await this.allPages(
      `query ProjectUpdates($projectId: ID!, $first: Int!, $after: String) {
        projectUpdates(first: $first, after: $after,
          filter: { project: { id: { eq: $projectId } } }) {
          nodes { ${PROJECT_UPDATE_FIELDS} } ${PAGE_INFO}
        }
      }`,
      { projectId },
      projectUpdateSchema,
      (data) => pickPath(data, "projectUpdates"),
    );
    return updates.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async createProjectUpdate(input: {
    readonly id?: string;
    readonly projectId: string;
    readonly body: string;
    readonly health?: Health;
  }): Promise<ProjectUpdate> {
    const result = await this.request(
      `mutation CreateProjectUpdate($input: ProjectUpdateCreateInput!) {
        projectUpdateCreate(input: $input) { projectUpdate { ${PROJECT_UPDATE_FIELDS} } }
      }`,
      { input },
      z.object({
        projectUpdateCreate: z.object({ projectUpdate: projectUpdateSchema }),
      }),
      this.recoverWith(input.id, async (id) => {
        const found = await this.request(
          `query ProjectUpdate($id: String!) { projectUpdate(id: $id) { ${PROJECT_UPDATE_FIELDS} } }`,
          { id },
          z.object({ projectUpdate: projectUpdateSchema }),
        );
        return { projectUpdateCreate: { projectUpdate: found.projectUpdate } };
      }),
    );
    return result.projectUpdateCreate.projectUpdate;
  }

  /**
   * A recovery for `request`: when the create carried a client id, reads the
   * object back by that id. Without an id there is nothing safe to read.
   */
  private recoverWith<T>(
    id: string | undefined,
    read: (id: string) => Promise<T>,
  ): (() => Promise<T>) | undefined {
    return id === undefined ? undefined : () => read(id);
  }
}

/** Walks `data` down `keys`, returning undefined where a step is missing. */
function pickPath(data: unknown, ...keys: readonly string[]): unknown {
  let current: unknown = data;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}
