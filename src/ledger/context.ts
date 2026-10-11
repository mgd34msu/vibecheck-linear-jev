// What every ledger tool shares: its dependencies, a per-team cache of the
// Linear facts tools read on every call (viewer, workflow states, labels),
// writes that fall back to the outbox when Linear cannot be reached, stable
// client ids for creates, and the translation of Linear failures into
// BoardErrors a tool returns.

import { createHash, randomUUID } from "node:crypto";
import { BoardError } from "../errors.js";
import type {
  Health,
  Issue,
  IssueFields,
  Label,
  LabelGroupType,
  LinearApi,
  Team,
  Viewer,
  WorkflowState,
} from "../linear/api.js";
import {
  isLinearError,
  LinearError,
  removeLabelIfPresent,
} from "../linear/errors.js";
import {
  parseClaimComment,
  resolveStates,
  withClaimActivity,
  type CommentAuthor,
  type ResolvedStates,
  type StateOverrides,
} from "../linear/states.js";
import type { LinearConfig } from "../jev/config.js";
import type {
  LocalStore,
  OutboxKind,
  ProjectKey,
  SessionRow,
} from "../local/types.js";
import type { LedgerVerifier } from "../verification/ledger.js";

export interface LedgerDeps {
  readonly store: LocalStore;
  /** The Linear client; throws BoardError `unavailable` when there is no key. */
  readonly linear: () => LinearApi;
  /** Runs the checks; without it work is recorded as reported. */
  readonly verifier: LedgerVerifier | undefined;
  /** True when the checks are off by configuration rather than for want of a usable source. */
  readonly checksOff: boolean;
  readonly config: LinearConfig;
  readonly now: () => Date;
  /** Cached per-team Linear facts, shared by every call this process serves. */
  readonly workspaces: Map<string, Workspace>;
}

/** A UUID derived from `parts`: the same request creating the same object gets the same id. */
export function stableId(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** A fresh client id for a create that is not part of a repeatable plan write. */
export function freshId(): string {
  return randomUUID();
}

/** True when Linear refused a create because the client id was already used. */
export function alreadyExists(error: unknown): boolean {
  return (
    isLinearError(error, "invalid") && /already exists/iu.test(error.message)
  );
}

/** The BoardError a tool returns for a Linear failure. */
export function boardErrorFor(error: LinearError): BoardError {
  switch (error.kind) {
    case "auth":
      return new BoardError(
        "unavailable",
        `Linear refused the API key: ${error.message}`,
      );
    case "rate_limited":
      return new BoardError(
        "unavailable",
        `Linear's rate limit is exhausted; try again in ${Math.ceil((error.retryAfterMs ?? 60_000) / 1000)} seconds.`,
      );
    case "network":
    case "server":
      return new BoardError(
        "unavailable",
        `Linear could not be reached: ${error.message}`,
      );
    case "not_found":
      return new BoardError("not_found", `Linear: ${error.message}`);
    case "invalid":
      return new BoardError(
        "invalid",
        `Linear rejected a write: ${error.message}`,
      );
  }
}

/** Who a tool comment names in its footer. */
export function authorOf(session: SessionRow): CommentAuthor {
  return {
    vendor: session.vendor,
    model: session.model,
    sessionId: session.id,
  };
}

/** Picks the team  */
export async function resolveTeam(
  api: LinearApi,
  wanted: string | null | undefined,
): Promise<Team> {
  const teams = await api.teams();
  if (wanted !== undefined && wanted !== null && wanted !== "") {
    const upper = wanted.toUpperCase();
    const team = teams.find(
      (entry) =>
        entry.key.toUpperCase() === upper ||
        entry.id === wanted ||
        entry.name.toUpperCase() === upper,
    );
    if (team === undefined)
      throw new BoardError(
        "not_found",
        `The Linear key sees no team ${wanted}; its teams are ${teams.map((entry) => entry.key).join(", ") || "none"}.`,
      );
    return team;
  }
  const [only, ...rest] = teams;
  if (only !== undefined && rest.length === 0) return only;
  throw new BoardError(
    "invalid",
    `The Linear key sees ${teams.length} teams (${teams.map((entry) => entry.key).join(", ")}); pass team, or set linear.team in the config.`,
    { teams: teams.map((entry) => entry.key) },
  );
}

/** Linear facts for one team, read once per process and refreshed on a miss. */
export class Workspace {
  readonly api: LinearApi;
  readonly teamId: string;
  private readonly overrides: StateOverrides;
  private viewerCache: Viewer | undefined;
  private statesCache:
    | {
        readonly all: readonly WorkflowState[];
        readonly resolved: ResolvedStates;
      }
    | undefined;
  private labelCache: readonly Label[] | undefined;
  /** Label ids a fresh read did not know either: not read again for them. */
  private readonly missedLabelIds = new Set<string>();
  private projectLabelCache: readonly Label[] | undefined;

  /** Where read label names are recorded for hooks, when given. */
  private readonly store: LocalStore | undefined;

  constructor(
    api: LinearApi,
    teamId: string,
    overrides: StateOverrides,
    store?: LocalStore,
  ) {
    this.api = api;
    this.teamId = teamId;
    this.overrides = overrides;
    this.store = store;
  }

  async viewer(): Promise<Viewer> {
    this.viewerCache ??= await this.api.viewer();
    return this.viewerCache;
  }

  async states(): Promise<{
    readonly all: readonly WorkflowState[];
    readonly resolved: ResolvedStates;
  }> {
    if (this.statesCache === undefined) {
      const all = await this.api.workflowStates(this.teamId);
      let resolved: ResolvedStates;
      try {
        resolved = resolveStates(all, this.overrides);
      } catch (error) {
        throw new BoardError(
          "invalid",
          error instanceof Error ? error.message : String(error),
        );
      }
      this.statesCache = { all, resolved };
    }
    return this.statesCache;
  }

  /** The first state of `type` by position (backlog for a restored task, unstarted for a release). */
  async firstState(
    ...types: readonly WorkflowState["type"][]
  ): Promise<WorkflowState | undefined> {
    const { all } = await this.states();
    for (const type of types) {
      const found = [...all]
        .filter((state) => state.type === type)
        .sort((left, right) => left.position - right.position)[0];
      if (found !== undefined) return found;
    }
    return undefined;
  }

  async labels(refresh = false): Promise<readonly Label[]> {
    if (refresh || this.labelCache === undefined) {
      this.labelCache = await this.api.labels(this.teamId);
      this.store?.putLabelNames(this.labelCache);
    }
    return this.labelCache;
  }

  /**
   * Label names by id. When `ids` names a label the cache does not know (one
   * another machine or a person created since the cache was read), the
   * team's labels are read again, once per unknown id.
   */
  async labelNames(ids: Iterable<string> = []): Promise<Map<string, string>> {
    const names = (labels: readonly Label[]) =>
      new Map(labels.map((label) => [label.id, label.name]));
    const cached = names(await this.labels());
    const unknown = [...new Set(ids)].filter(
      (id) => !cached.has(id) && !this.missedLabelIds.has(id),
    );
    if (unknown.length === 0) return cached;
    const fresh = names(await this.labels(true));
    for (const id of unknown) if (!fresh.has(id)) this.missedLabelIds.add(id);
    return fresh;
  }

  /** An issue label by name, any case; re-reads Linear once on a miss. */
  async findLabel(name: string): Promise<Label | undefined> {
    const lower = name.toLowerCase();
    const match = (labels: readonly Label[]) =>
      labels.find((label) => label.name.toLowerCase() === lower);
    return match(await this.labels()) ?? match(await this.labels(true));
  }

  /** The issue label named `name`, created (ungrouped, workspace-wide unless `teamId`) when missing. */
  async ensureLabel(
    name: string,
    color: string,
    extra: {
      readonly id?: string;
      readonly description?: string;
      readonly parentId?: string;
      readonly isGroup?: boolean;
      readonly groupType?: LabelGroupType;
    } = {},
  ): Promise<Label> {
    const found = await this.findLabel(name);
    if (found !== undefined) return found;
    try {
      const created = await this.api.createLabel({
        name,
        color,
        ...extra,
      });
      this.labelCache = [...(this.labelCache ?? []), created];
      this.store?.putLabelNames([created]);
      return created;
    } catch (error) {
      if (!isLinearError(error, "invalid")) throw error;
      const raced = await this.findLabel(name);
      if (raced !== undefined) return raced;
      throw error;
    }
  }

  async projectLabels(refresh = false): Promise<readonly Label[]> {
    if (refresh || this.projectLabelCache === undefined)
      this.projectLabelCache = await this.api.projectLabels();
    return this.projectLabelCache;
  }

  /** The project label named `name`, created when missing. */
  async ensureProjectLabel(
    name: string,
    color: string | undefined,
    extra: { readonly id?: string; readonly description?: string } = {},
  ): Promise<Label> {
    const lower = name.toLowerCase();
    const match = (labels: readonly Label[]) =>
      labels.find((label) => label.name.toLowerCase() === lower);
    const found =
      match(await this.projectLabels()) ??
      match(await this.projectLabels(true));
    if (found !== undefined) return found;
    const created = await this.api.createProjectLabel({
      name,
      ...(color === undefined ? {} : { color }),
      ...extra,
    });
    this.projectLabelCache = [...(this.projectLabelCache ?? []), created];
    return created;
  }
}

/** The cached Workspace for a team. */
export function workspaceFor(deps: LedgerDeps, teamId: string): Workspace {
  let workspace = deps.workspaces.get(teamId);
  if (workspace === undefined) {
    workspace = new Workspace(
      deps.linear(),
      teamId,
      deps.config.states ?? {},
      deps.store,
    );
    deps.workspaces.set(teamId, workspace);
  }
  return workspace;
}

/** A label as a write names it: the id to send now, the name to queue. */
export interface LabelRef {
  readonly id: string;
  readonly name: string;
}

/** What a queued state move expects to find when it is finally sent. */
export interface MoveExpectation {
  /** The state the tool saw the issue in when it decided the move. */
  readonly stateId?: string | undefined;
  /** The project the issue must still belong to. */
  readonly projectId?: string | undefined;
}

/**
 * The issue a queued row writes to, when it names one: rows of one issue are
 * sent in order, so a row that cannot be sent holds back the later rows of
 * its issue only.
 */
export function queuedIssueOf(row: {
  readonly kind: OutboxKind;
  readonly payload: Readonly<Record<string, unknown>>;
}): string | undefined {
  const issueId = row.payload["issueId"];
  if (typeof issueId === "string") return issueId;
  const id = row.payload["id"];
  return row.kind === "update_issue" && typeof id === "string" ? id : undefined;
}

/**
 * Whether `issueId` has queued rows still waiting to be sent (any number of
 * them: the check reads the outbox for that issue, not a window of rows).
 */
export function issueQueued(store: LocalStore, issueId: string): boolean {
  return store.issueQueued(issueId);
}

/**
 * Linear writes for one tool call. A write that fails because Linear is
 * unreachable or rate limited goes to the outbox, and so does every later
 * write of the call, oldest first; `queued` counts them. A write to an issue
 * that already has older queued rows is queued behind them instead of sent,
 * so it never overtakes them (the drain sends one issue's rows in order). A
 * create Linear refuses because its client id exists already counts as done.
 * Editing a comment a person deleted, removing a label that is gone, or
 * removing one the issue does not carry (Linear refuses that) counts as done
 * too: there is nothing left to change. Queued label writes carry the label
 * name, which the drain resolves (creating a missing `vc:*` or `agent:*`
 * label), and queued state moves carry the state the tool expected, so the
 * drain skips a move a person overtook.
 */
export class Writer {
  private readonly store: LocalStore;
  private readonly api: LinearApi;
  private readonly projectKey: ProjectKey | null;
  private failure: LinearError | undefined;
  queued = 0;

  constructor(
    store: LocalStore,
    api: LinearApi,
    projectKey: ProjectKey | null,
  ) {
    this.store = store;
    this.api = api;
    this.projectKey = projectKey;
  }

  /** Whether an earlier write of this call failed and later ones are queued. */
  get offline(): boolean {
    return this.failure !== undefined;
  }

  /** Whether a write to `issueId` must queue behind older queued rows of that issue. */
  behindQueue(issueId: string | undefined): boolean {
    return issueId !== undefined && issueQueued(this.store, issueId);
  }

  private async send(
    kind: OutboxKind,
    payload: Readonly<Record<string, unknown>>,
    call: () => Promise<unknown>,
    missingIsDone = false,
  ): Promise<boolean> {
    if (
      this.failure === undefined &&
      !this.behindQueue(queuedIssueOf({ kind, payload }))
    ) {
      try {
        await call();
        return true;
      } catch (error) {
        if (alreadyExists(error)) return true;
        if (missingIsDone && isLinearError(error, "not_found")) return false;
        if (!isLinearError(error, "network", "server", "rate_limited"))
          throw error;
        this.failure = error;
      }
    }
    this.store.enqueue({ projectKey: this.projectKey, kind, payload });
    this.queued += 1;
    return false;
  }

  comment(
    issueId: string,
    body: string,
    id: string = freshId(),
  ): Promise<boolean> {
    const payload = { id, issueId, body };
    return this.send("comment", payload, () => this.api.createComment(payload));
  }

  /** Edits a comment; false when a person deleted it (nothing to edit). */
  updateComment(id: string, body: string, issueId?: string): Promise<boolean> {
    return this.send(
      "update_comment",
      { id, body, ...(issueId === undefined ? {} : { issueId }) },
      () => this.api.updateComment(id, body),
      true,
    );
  }

  /**
   * Records activity on a work's open claim comment: re-reads the comment and
   * rewrites only its claim line to `open · active <at>`, keeping the rest
   * (a person's text included) exactly. "lost" when the comment is gone, no
   * longer open or not this work's: nothing is written. When Linear cannot
   * be reached, or older rows of the issue are queued, the edit is queued,
   * and the drain applies the same rule.
   */
  async claimActivity(input: {
    readonly commentId: string;
    readonly issueId: string;
    readonly workId: string;
    readonly at: string;
    /** The full claim comment, for the queued row of an older drain. */
    readonly body: string;
  }): Promise<"written" | "queued" | "lost"> {
    if (this.failure === undefined && !this.behindQueue(input.issueId)) {
      try {
        const current = (await this.api.comments(input.issueId)).find(
          (comment) => comment.id === input.commentId,
        );
        const parsed =
          current === undefined ? null : parseClaimComment(current.body);
        if (
          current === undefined ||
          parsed === null ||
          parsed.workId !== input.workId ||
          parsed.status !== "open"
        )
          return "lost";
        await this.api.updateComment(
          current.id,
          withClaimActivity(current.body, input.at),
        );
        return "written";
      } catch (error) {
        if (isLinearError(error, "not_found")) return "lost";
        if (!isLinearError(error, "network", "server", "rate_limited"))
          throw error;
        this.failure = error;
      }
    }
    this.store.enqueue({
      projectKey: this.projectKey,
      kind: "update_comment",
      payload: {
        id: input.commentId,
        body: input.body,
        issueId: input.issueId,
        onlyIfOpenClaim: true,
        workId: input.workId,
        activeAt: input.at,
      },
    });
    this.queued += 1;
    return "queued";
  }

  /**
   * Adds one of the tool's own labels (`vc:*`, `agent:*`), creating it on
   * first use inside the same write: when Linear stops answering while the
   * label is created, the add is queued by name and the drain creates the
   * label. The label when it was sent; its name alone when queued.
   */
  async addOwnLabel(
    issueId: string,
    workspace: Workspace,
    name: string,
    color: string,
    description = "Set by vibecheck-linear-jev.",
  ): Promise<LabelRef> {
    let label: Label | undefined;
    await this.send("add_label", { issueId, labelName: name }, async () => {
      label = await workspace.ensureLabel(name, color, { description });
      await this.api.addLabel(issueId, label.id);
    });
    return label === undefined ? { id: "", name } : label;
  }

  /**
   * Removes a label by name without creating it; a label that does not
   * exist, or that the issue does not carry, is nothing to remove.
   */
  async removeNamedLabel(
    issueId: string,
    workspace: Workspace,
    name: string,
  ): Promise<boolean> {
    return this.send(
      "remove_label",
      { issueId, labelName: name },
      async () => {
        const label = await workspace.findLabel(name);
        if (label !== undefined)
          await removeLabelIfPresent(this.api, issueId, label.id);
      },
      true,
    );
  }

  addLabel(issueId: string, label: LabelRef): Promise<boolean> {
    return this.send("add_label", { issueId, labelName: label.name }, () =>
      this.api.addLabel(issueId, label.id),
    );
  }

  removeLabel(issueId: string, label: LabelRef): Promise<boolean> {
    return this.send(
      "remove_label",
      { issueId, labelName: label.name },
      () => removeLabelIfPresent(this.api, issueId, label.id),
      true,
    );
  }

  /** Updates an issue; the updated issue when sent, undefined when queued. */
  async updateIssue(
    id: string,
    input: IssueFields,
    expect: MoveExpectation = {},
  ): Promise<Issue | undefined> {
    let updated: Issue | undefined;
    await this.send(
      "update_issue",
      {
        id,
        input: { ...input },
        ...(expect.stateId === undefined
          ? {}
          : { expectStateId: expect.stateId }),
        ...(expect.projectId === undefined
          ? {}
          : { expectProjectId: expect.projectId }),
      },
      async () => {
        updated = await this.api.updateIssue(id, input);
      },
    );
    return updated;
  }

  /** Creates an issue relation with a client id, so a resend cannot duplicate it. */
  relation(input: {
    readonly id: string;
    readonly type: "related" | "blocks";
    readonly issueId: string;
    readonly relatedIssueId: string;
  }): Promise<boolean> {
    return this.send("relation", { ...input }, () =>
      this.api.createRelation(input),
    );
  }

  projectUpdate(input: {
    readonly id: string;
    readonly projectId: string;
    readonly body: string;
    readonly health?: Health;
  }): Promise<boolean> {
    return this.send("project_update", { ...input }, () =>
      this.api.createProjectUpdate(input),
    );
  }
}
