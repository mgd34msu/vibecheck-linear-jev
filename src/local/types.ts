// The local store: what vibecheck-linear-jev keeps on this machine beside
// Linear. Linear holds the plan, the tasks and their state; this store holds
// what Linear has no place for or what must not wait on the network:
//
//   projects      local project key -> Linear project, team, documents, repository
//   sessions      agent sessions: identity, ancestry, coordinator, plan acknowledgment
//   claims        work records (a session's claim on an issue) and their facts
//   receipts      idempotency: request id -> cached result
//   journal       every plan revision's task map, for plan_read and comparisons
//   cache         the latest copy of each project's issues, for hooks and status
//   outbox        Linear writes waiting to be sent
//   events        what the reconciler found in Linear (reopened, removed,
//                 human replies, lost claims), done re-checks still waiting
//                 to run, and the tool's own queued state moves
//   completions   the recorded plan of each completion, release and handoff:
//                 the decision, the ordered Linear steps, how far they got
//   entries       verification history (verdict, unavailable, label, report);
//                 the schema in src/verification/store.ts, unchanged
//
// One SQLite file, `$XDG_DATA_HOME/vibecheck-linear-jev/state.sqlite3` (Bun's
// bun:sqlite), WAL mode. Implementation: src/local/store.ts.

import type { Issue } from "../linear/api.js";
import type { SqlAccess } from "../sqlite.js";

export type ProjectKey = string & { readonly __brand: "ProjectKey" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type WorkId = string & { readonly __brand: "WorkId" };

/**
 * How the tool may treat the Linear project:
 * `created` by the tool, an existing project used `as_is`, or an existing
 * project the tool may adjust (`managed`); `pending` until the user answers.
 */
export type AdoptionMode = "created" | "as_is" | "managed" | "pending";

export interface ProjectRow {
  readonly key: ProjectKey;
  /** Empty until the project exists in Linear (created at the first plan_publish). */
  readonly linearProjectId: string;
  readonly teamId: string;
  /** Repository identities: paths, git top levels, origin URLs. */
  readonly repositories: readonly string[];
  readonly policyDocumentId: string | null;
  readonly planDocumentId: string | null;
  readonly planRevision: number;
  readonly coordinatorSessionId: SessionId | null;
  /** The newest issue updatedAt the cache has seen; the reconciler's cursor. */
  readonly syncedThrough: string | null;
  readonly adoption: AdoptionMode;
  /** Managed mode: whether a plan write was confirmed after its dry run. */
  readonly managedConfirmed: boolean;
  /**
   * Managed mode: the hash of the last dry run shown, so `confirm: true`
   * applies only a request whose dry run the user saw.
   */
  readonly dryRunHash?: string | null | undefined;
  /**
   * When the plan first passed readiness: until
   * then every plan write is gated. A managed `issue_adopt` does not set it.
   */
  readonly readyAt?: string | null | undefined;
  /** The policy as last read from Linear, for hooks that never call Linear. */
  readonly policy: Readonly<Record<string, unknown>> | null;
  /** The Linear project's URL and name as last seen. */
  readonly url: string | null;
  readonly name: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionRow {
  readonly id: SessionId;
  readonly projectKey: ProjectKey;
  readonly vendor: string;
  readonly runtime: string;
  readonly externalSessionId: string;
  readonly model: string;
  readonly effort: string | null;
  readonly parentSessionId: SessionId | null;
  /** The agent label applied to issues this session touches, e.g. `agent:claude-code`. */
  readonly agentLabel: string;
  readonly acknowledgedPlanRevision: number | null;
  readonly acknowledgedAt: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

export type WorkStatus =
  | "in_progress"
  | "blocked"
  | "awaiting_integration"
  | "complete"
  | "released"
  | "abandoned"
  | "conflict";

export interface WorkLocation {
  readonly repository: string | null;
  readonly checkout: string | null;
  readonly branch: string | null;
  readonly targetBranch: string | null;
  readonly baseCommit: string | null;
  readonly paths: readonly string[];
}

export interface WorkRow {
  readonly id: WorkId;
  readonly projectKey: ProjectKey;
  /** Linear issue UUID. */
  readonly issueId: string;
  /** Linear identifier, e.g. `TA-42`. */
  readonly identifier: string;
  readonly sessionId: SessionId;
  readonly status: WorkStatus;
  readonly blocker: string | null;
  readonly location: WorkLocation;
  readonly commit: string | null;
  readonly integrationCommit: string | null;
  readonly integrationRequired: boolean;
  /** The claim comment in Linear that records this claim. */
  readonly claimCommentId: string | null;
  readonly predecessorWorkId: WorkId | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One task in a plan revision, keyed by the plan's own task key. */
export interface JournalTask {
  readonly key: string;
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  /** The rendered task definition as published at this revision. */
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface JournalRevision {
  readonly projectKey: ProjectKey;
  readonly revision: number;
  readonly sessionId: SessionId | null;
  readonly createdAt: string;
  readonly tasks: readonly JournalTask[];
  readonly policy: Readonly<Record<string, unknown>> | null;
  /** The plan-level definition (project fields, labels, milestones, documents, links). */
  readonly plan: Readonly<Record<string, unknown>> | null;
}

export type EventKind =
  | "reopened"
  /** A person moved an issue to done while this machine's work held its done report. */
  | "held_done_moved"
  | "removed"
  | "human_reply"
  | "recheck"
  | "skipped_move"
  /** Another machine or a person closed this machine's open claim comment. */
  | "claim_lost"
  /** A queued Linear write was set aside after Linear rejected it MAX_ATTEMPTS times. */
  | "write_dropped"
  /**
   * Not attention: the tool queued its own state move of an issue, so the
   * reconciler does not take that state, once it lands, for a person's move.
   */
  | "expected_move"
  /**
   * Not attention: where this machine's local done entries for an issue
   * stop counting (a verification seq). Set when the issue leaves a
   * completed state, reaches one by someone else's move, gets a new claim
   * here, or carries another verdict label than the local entries say.
   */
  | "verdict_floor";

/** Something the reconciler found, shown in status until it is cleared. */
export interface EventRow {
  readonly id: number;
  readonly projectKey: ProjectKey;
  readonly kind: EventKind;
  readonly issueId: string;
  readonly identifier: string;
  readonly workId: WorkId | null;
  /** Unique per project; a second event with the same key is not added. */
  readonly dedupe: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly clearedAt: string | null;
}

/** What closing a claim decided: the done checks' decision, or a release or handoff. */
export type CompletionKind = "complete" | "release" | "handoff";

/** The done decision a completion recorded before its first Linear write. */
export type CompletionDecision = "verified" | "unverified" | "held";

/**
 * One step of a completion plan. Every step is idempotent and checks its
 * precondition in Linear when it runs.
 */
export type CompletionStep =
  /**
   * Move the issue to `stateId`, only from `expectStateId` (the state the
   * tool saw). `required`: a skipped move abandons the plan (a completion);
   * otherwise it is reported and the plan goes on (a release).
   */
  | {
      readonly kind: "move";
      readonly stateId: string;
      readonly expectStateId: string | null;
      /**
       * States the tool's own queued moves of the issue bring it to (pending
       * expected-move markers when the plan was recorded): found there, the
       * issue was not moved by a person either.
       */
      readonly alsoExpect?: readonly string[] | undefined;
      readonly required: boolean;
    }
  | { readonly kind: "add_label"; readonly name: string }
  | { readonly kind: "remove_label"; readonly name: string }
  /** Ensure the agent label `name` exists and add it. */
  | { readonly kind: "agent_label"; readonly name: string }
  /** Create a comment with a deterministic id ("already exists" is done). */
  | { readonly kind: "comment"; readonly id: string; readonly body: string }
  /** Rewrite the open claim line to `open · active <at>`. */
  | { readonly kind: "activity"; readonly at: string }
  /** Write the plan's closing status on this work's claim comment. */
  | { readonly kind: "close_claim" }
  /** Remove `vc:claimed` when no claim comment on the issue is open. */
  | { readonly kind: "drop_claimed" };

/** Where a completion plan stands. */
export type CompletionState = "pending" | "done" | "abandoned";

/**
 * A completion plan: recorded locally before
 * its first Linear write, keyed by (work, session, request id), and resumed
 * with the same decision until it is done or abandoned.
 */
export interface CompletionRow {
  /** stableId of (work id, session id, request id). */
  readonly id: string;
  readonly projectKey: ProjectKey;
  readonly workId: WorkId;
  /** The session whose request recorded the plan. */
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly issueId: string;
  readonly identifier: string;
  readonly taskKey: string;
  readonly kind: CompletionKind;
  readonly decision: CompletionDecision | null;
  /**
   * The status this machine writes on the work's claim comment; null when
   * the claim stays open (a held completion). The reconciler reads a claim
   * comment carrying it as this machine's own close, never as `claim_lost`.
   */
  readonly closingStatus: string | null;
  readonly steps: readonly CompletionStep[];
  /** How many steps, from the first, are done. */
  readonly done: number;
  readonly state: CompletionState;
  /** Why the plan was abandoned, or the last failure while pending. */
  readonly reason: string | null;
  /** Runs that stopped on a failure. */
  readonly attempts: number;
  /** The hash of the requested change, so a retry must repeat it exactly. */
  readonly changeHash: string;
  /** The change as requested (the report history records it). */
  readonly change: Readonly<Record<string, unknown>>;
  /** The work rows the local commit writes (the work, and a handoff's successor). */
  readonly rows: readonly WorkRow[];
  /** The task status the result reports once the plan is done. */
  readonly taskStatus: string;
  /** The verification items the decision recorded, for the result. */
  readonly verification: readonly Readonly<Record<string, unknown>>[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type OutboxKind =
  | "comment"
  | "update_comment"
  | "add_label"
  | "remove_label"
  | "update_issue"
  | "project_update"
  | "relation";

export interface OutboxRow {
  readonly id: number;
  readonly projectKey: ProjectKey | null;
  readonly kind: OutboxKind;
  /** The LinearApi call's input, with a client-generated `id` where the call creates something. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface LocalStore {
  close(): void;

  /** Runs `fn` in one SQLite write transaction. */
  transaction<T>(fn: () => T): T;

  /** Row access for the verification history (src/verification/store.ts). */
  verificationAccess(): SqlAccess;

  project(key: ProjectKey): ProjectRow | undefined;
  projectByLinearId(linearProjectId: string): ProjectRow | undefined;
  /** Every project on this machine, newest first. */
  allProjects(): readonly ProjectRow[];
  /** Projects whose repository identities include any of `identities`, newest first. */
  projectsForRepository(identities: readonly string[]): readonly ProjectRow[];
  putProject(row: ProjectRow): void;

  session(id: SessionId): SessionRow | undefined;
  sessionByExternal(
    vendor: string,
    runtime: string,
    externalSessionId: string,
  ): SessionRow | undefined;
  /** Newest session with this client session id, any vendor. Hooks use this. */
  sessionByExternalId(externalSessionId: string): SessionRow | undefined;
  sessions(projectKey: ProjectKey): readonly SessionRow[];
  putSession(row: SessionRow): void;

  work(id: WorkId): WorkRow | undefined;
  workForIssue(projectKey: ProjectKey, issueId: string): readonly WorkRow[];
  openWork(projectKey: ProjectKey): readonly WorkRow[];
  /** Every work row of the project, oldest first. */
  allWork(projectKey: ProjectKey): readonly WorkRow[];
  workForSession(sessionId: SessionId): readonly WorkRow[];
  putWork(row: WorkRow): void;

  /** The cached result for a request, or undefined. */
  receipt(
    scope: string,
    requestId: string,
  ): { readonly inputHash: string; readonly result: unknown } | undefined;
  putReceipt(
    scope: string,
    requestId: string,
    inputHash: string,
    result: unknown,
  ): void;
  /** Deletes receipts older than `days`. */
  pruneReceipts(days: number): void;

  revision(
    projectKey: ProjectKey,
    revision: number,
  ): JournalRevision | undefined;
  putRevision(row: JournalRevision): void;

  cachedIssues(projectKey: ProjectKey): readonly Issue[];
  /** Upserts by issue id. */
  cacheIssues(projectKey: ProjectKey, issues: readonly Issue[]): void;
  /** Forgets an issue that left the project or was archived. */
  uncacheIssue(projectKey: ProjectKey, issueId: string): void;

  enqueue(
    row: Omit<OutboxRow, "id" | "attempts" | "lastError" | "createdAt">,
  ): number;
  pending(limit: number): readonly OutboxRow[];
  /** Unsent outbox rows. */
  pendingCount(): number;
  /**
   * Whether an unsent outbox row writes to `issueId` (its payload `issueId`,
   * or the `id` of an `update_issue` row), however many rows wait.
   */
  issueQueued(issueId: string): boolean;

  /** Records label names by id, as last read from Linear (for hooks). */
  putLabelNames(labels: readonly { id: string; name: string }[]): void;
  /** Label names by id, as last recorded. */
  labelNames(): Map<string, string>;
  markSent(id: number): void;
  markFailed(id: number, error: string): void;

  completion(id: string): CompletionRow | undefined;
  /** Pending completion plans, oldest first: of one project, or of every project. */
  pendingCompletions(projectKey?: ProjectKey): readonly CompletionRow[];
  /** Completion plans of one work, oldest first. */
  completionsForWork(workId: WorkId): readonly CompletionRow[];
  putCompletion(row: CompletionRow): void;

  /** Adds an event; false when one with the same dedupe key exists. */
  addEvent(row: Omit<EventRow, "id" | "createdAt" | "clearedAt">): boolean;
  /** Events oldest first; only uncleared ones unless `all`. */
  events(
    projectKey: ProjectKey,
    filter?: { readonly kinds?: readonly EventKind[]; readonly all?: boolean },
  ): readonly EventRow[];
  clearEvent(id: number): void;
}
