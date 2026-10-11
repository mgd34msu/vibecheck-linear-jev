// FileMemoryLinearApi: MemoryLinearApi whose workspace lives in a JSON file,
// so separate processes (the MCP server, hooks, a test driving both) share
// one fake Linear. Test-only: the runtime uses it only when
// VIBECHECK_LINEAR_JEV_LINEAR_BACKEND=memory and
// VIBECHECK_LINEAR_JEV_MEMORY_FILE names the file (src/linear/open.ts).
//
// Every call takes an exclusive lock file beside the state file, loads the
// workspace, runs the call against a fresh MemoryLinearApi, and writes the
// workspace back through a temporary file and a rename, so a reader never
// sees half a file.

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
import { LinearError } from "./errors.js";
import { MemoryLinearApi, memoryStateSchema } from "./memory.js";

const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** MemoryLinearApi persisted to one JSON file shared across processes. */
export class FileMemoryLinearApi implements LinearApi {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private async lock(): Promise<() => void> {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx"));
        return () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // already gone
          }
        };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS)
          unlinkSync(lockPath);
      } catch {
        // the holder released it meanwhile
      }
      if (Date.now() > deadline)
        throw new LinearError(
          "server",
          `The memory workspace ${this.path} stayed locked.`,
        );
      await pause(5);
    }
  }

  /** Runs one call against the workspace in the file and saves the result. */
  async run<T>(call: (api: MemoryLinearApi) => Promise<T>): Promise<T> {
    const release = await this.lock();
    try {
      const api = new MemoryLinearApi();
      if (existsSync(this.path))
        api.importState(
          memoryStateSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))),
        );
      try {
        return await call(api);
      } finally {
        const temporary = `${this.path}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(api.exportState()));
        renameSync(temporary, this.path);
      }
    } finally {
      release();
    }
  }

  rateLimit(): RateLimit | null {
    return null;
  }
  viewer(): Promise<Viewer> {
    return this.run((api) => api.viewer());
  }
  teams(): Promise<readonly Team[]> {
    return this.run((api) => api.teams());
  }
  workflowStates(teamId: string): Promise<readonly WorkflowState[]> {
    return this.run((api) => api.workflowStates(teamId));
  }
  projectStatuses(): Promise<readonly ProjectStatus[]> {
    return this.run((api) => api.projectStatuses());
  }
  labels(teamId: string): Promise<readonly Label[]> {
    return this.run((api) => api.labels(teamId));
  }
  createLabel(input: NewLabel): Promise<Label> {
    return this.run((api) => api.createLabel(input));
  }
  projectLabels(): Promise<readonly Label[]> {
    return this.run((api) => api.projectLabels());
  }
  createProjectLabel(
    input: Omit<NewLabel, "groupType" | "teamId">,
  ): Promise<Label> {
    return this.run((api) => api.createProjectLabel(input));
  }
  project(idOrSlug: string): Promise<Project | null> {
    return this.run((api) => api.project(idOrSlug));
  }
  createProject(input: NewProject): Promise<Project> {
    return this.run((api) => api.createProject(input));
  }
  updateProject(id: string, input: Partial<ProjectFields>): Promise<Project> {
    return this.run((api) => api.updateProject(id, input));
  }
  deleteProject(id: string): Promise<void> {
    return this.run((api) => api.deleteProject(id));
  }
  projects(nameContains?: string): Promise<readonly Project[]> {
    return this.run((api) => api.projects(nameContains));
  }
  milestones(projectId: string): Promise<readonly Milestone[]> {
    return this.run((api) => api.milestones(projectId));
  }
  createMilestone(input: NewMilestone): Promise<Milestone> {
    return this.run((api) => api.createMilestone(input));
  }
  updateMilestone(
    id: string,
    input: Partial<Omit<NewMilestone, "id" | "projectId">>,
  ): Promise<Milestone> {
    return this.run((api) => api.updateMilestone(id, input));
  }
  documents(projectId: string): Promise<readonly Document[]> {
    return this.run((api) => api.documents(projectId));
  }
  createDocument(input: NewDocument): Promise<Document> {
    return this.run((api) => api.createDocument(input));
  }
  updateDocument(
    id: string,
    input: Partial<Omit<NewDocument, "id" | "projectId">>,
  ): Promise<Document> {
    return this.run((api) => api.updateDocument(id, input));
  }
  externalLinks(projectId: string): Promise<readonly ExternalLink[]> {
    return this.run((api) => api.externalLinks(projectId));
  }
  createExternalLink(
    projectId: string,
    input: {
      readonly id?: string;
      readonly label: string;
      readonly url: string;
    },
  ): Promise<ExternalLink> {
    return this.run((api) => api.createExternalLink(projectId, input));
  }
  issues(filter: IssueFilter, after?: string): Promise<Page<Issue>> {
    return this.run((api) => api.issues(filter, after));
  }
  issue(idOrIdentifier: string): Promise<Issue | null> {
    return this.run((api) => api.issue(idOrIdentifier));
  }
  createIssue(input: NewIssue): Promise<Issue> {
    return this.run((api) => api.createIssue(input));
  }
  updateIssue(id: string, input: IssueFields): Promise<Issue> {
    return this.run((api) => api.updateIssue(id, input));
  }
  addLabel(issueId: string, labelId: string): Promise<void> {
    return this.run((api) => api.addLabel(issueId, labelId));
  }
  removeLabel(issueId: string, labelId: string): Promise<void> {
    return this.run((api) => api.removeLabel(issueId, labelId));
  }
  relations(issueId: string): Promise<readonly Relation[]> {
    return this.run((api) => api.relations(issueId));
  }
  createRelation(input: {
    readonly id?: string;
    readonly type: RelationType;
    readonly issueId: string;
    readonly relatedIssueId: string;
  }): Promise<Relation> {
    return this.run((api) => api.createRelation(input));
  }
  deleteRelation(id: string): Promise<void> {
    return this.run((api) => api.deleteRelation(id));
  }
  comments(issueId: string): Promise<readonly Comment[]> {
    return this.run((api) => api.comments(issueId));
  }
  createComment(input: {
    readonly id?: string;
    readonly issueId: string;
    readonly body: string;
  }): Promise<Comment> {
    return this.run((api) => api.createComment(input));
  }
  updateComment(id: string, body: string): Promise<Comment> {
    return this.run((api) => api.updateComment(id, body));
  }
  deleteComment(id: string): Promise<void> {
    return this.run((api) => api.deleteComment(id));
  }
  pullRequests(issueId: string): Promise<readonly LinkedPullRequest[]> {
    return this.run((api) => api.pullRequests(issueId));
  }
  projectUpdates(projectId: string): Promise<readonly ProjectUpdate[]> {
    return this.run((api) => api.projectUpdates(projectId));
  }
  createProjectUpdate(input: {
    readonly id?: string;
    readonly projectId: string;
    readonly body: string;
    readonly health?: Health;
  }): Promise<ProjectUpdate> {
    return this.run((api) => api.createProjectUpdate(input));
  }
}
