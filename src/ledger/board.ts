// The ledger's eleven tools behind one entry point.
//
// `Board.call(tool, arguments)` validates the request with its zod schema,
// drains the outbox, resumes the project's pending completion plans, and
// runs the tool. Calls for one project run one at a
// time in this process; other processes coordinate through the local store
// and, for claims, through Linear itself. Mutations keep idempotency
// receipts: the same request id with the same input returns the stored
// result without writing again, and with different input is a conflict.
// Receipts are scoped to the joining identity for project_join and to the
// session for every other mutation. A managed-mode dry run, an adoption
// question and a work_update batch where a change failed are not stored, so
// the follow-up request can run (work_update remembers each change that
// landed and reports it as applied on the retry).
//
// Every result is plain JSON. Linear failures become BoardErrors: an
// unreachable or rate-limited Linear is `unavailable`, a refused write is
// `invalid`.

import { createHash } from "node:crypto";
import { z } from "zod";
import { BoardError } from "../errors.js";
import type { LinearApi } from "../linear/api.js";
import { isLinearError } from "../linear/errors.js";
import type { LinearConfig } from "../jev/config.js";
import type { LocalStore, ProjectKey } from "../local/types.js";
import {
  issueAdoptSchema,
  jsonValueSchema,
  planAckSchema,
  planEditSchema,
  planPublishSchema,
  planReadSchema,
  projectJoinSchema,
  projectStatusSchema,
  projectUpdateRequestSchema,
  TOOL_NAMES,
  workClaimSchema,
  workHistorySchema,
  workUpdateSchema,
  type JsonValue,
  type ToolName,
} from "../schemas.js";
import { encode } from "../sqlite.js";
import { projectKeyOf } from "./access.js";
import type { LedgerVerifier } from "../verification/ledger.js";
import { boardErrorFor, type LedgerDeps, type Workspace } from "./context.js";
import { projectJoin } from "./join.js";
import { drainOutbox } from "./outbox.js";
import { resumeCompletions } from "./completion.js";
import {
  issueAdopt,
  planAck,
  planEdit,
  planPublish,
  planRead,
} from "./plan.js";
import { projectStatus, projectUpdate, workHistory } from "./status.js";
import { workClaim, workUpdate } from "./work.js";

/** How long idempotency receipts are kept. */
export const RECEIPT_RETENTION_DAYS = 30;

export type JsonObject = { readonly [key: string]: JsonValue };

export interface BoardOptions {
  readonly store: LocalStore;
  /** The Linear client, or a factory; absent means Linear is unavailable for `linearUnavailable`. */
  readonly linear?: LinearApi | (() => LinearApi);
  /** Why there is no Linear client (no key found), named in every Linear-bound error. */
  readonly linearUnavailable?: string;
  readonly verifier?: LedgerVerifier;
  /** The user turned the checks off (`ledger.verify: false`): no verifier, on purpose. */
  readonly checksOff?: boolean;
  readonly config?: LinearConfig;
  readonly now?: () => Date;
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new BoardError(
    "invalid",
    "invalid tool arguments",
    parsed.error.issues.map((issue) => ({
      field: issue.path.map((part) =>
        typeof part === "symbol" ? String(part) : part,
      ),
      message: issue.message,
      type: issue.code,
    })),
  );
}

const objectSchema = z.record(z.string(), jsonValueSchema);
/** The receipt of a work_update batch where a change failed: its input only. */
const PARTIAL = "partial_batch";
const failedResults = z.object({
  results: z.array(z.object({ outcome: z.string() })),
});

function toJson(value: object): JsonObject {
  return objectSchema.parse(JSON.parse(JSON.stringify(value)));
}

const MUTATIONS: ReadonlySet<ToolName> = new Set([
  "project_join",
  "plan_publish",
  "plan_edit",
  "plan_ack",
  "issue_adopt",
  "work_claim",
  "work_update",
  "project_update",
]);

/** The project whose pending completion plans a call resumes first. */
function drainKey(value: unknown): ProjectKey | undefined {
  const parsed = z.object({ project_id: z.string() }).safeParse(value);
  if (!parsed.success) return undefined;
  try {
    return projectKeyOf(parsed.data.project_id);
  } catch {
    // An invalid project id fails validation in the tool itself.
    return undefined;
  }
}

function isToolName(value: string): value is ToolName {
  return TOOL_NAMES.some((name) => name === value);
}

export class Board {
  readonly deps: LedgerDeps;
  private readonly chains = new Map<string, Promise<unknown>>();
  private calls = 0;

  constructor(options: BoardOptions) {
    const linear = options.linear;
    const factory: () => LinearApi =
      linear === undefined
        ? () => {
            throw new BoardError(
              "unavailable",
              `Linear is not available: ${options.linearUnavailable ?? "no Linear client was configured"}. Set LINEAR_API_KEY or linear.apiKeyFile.`,
            );
          }
        : typeof linear === "function"
          ? linear
          : () => linear;
    this.deps = {
      store: options.store,
      linear: factory,
      verifier: options.verifier,
      checksOff: options.checksOff ?? false,
      config: options.config ?? {},
      now: options.now ?? (() => new Date()),
      workspaces: new Map<string, Workspace>(),
    };
  }

  /** Runs `work` after every earlier call for the same project has finished. */
  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return run;
  }

  /**
   * Sends queued writes, then resumes pending completion plans (of one
   * project, or of every project without `projectKey`); failures leave both
   * for the next call.
   */
  async drain(projectKey?: ProjectKey): Promise<{
    sent: number;
    pending: number;
    stopped?: string;
    completions: { resumed: number; pending: number };
  }> {
    const { store } = this.deps;
    const waiting = () => ({
      resumed: 0,
      pending: store.pendingCompletions(projectKey).length,
    });
    let api: LinearApi;
    try {
      api = this.deps.linear();
    } catch {
      return { sent: 0, pending: store.pendingCount(), completions: waiting() };
    }
    let drained: { sent: number; pending: number; stopped?: string };
    try {
      drained = await drainOutbox(store, api);
    } catch (error) {
      drained = {
        sent: 0,
        pending: store.pendingCount(),
        stopped: error instanceof Error ? error.message : String(error),
      };
    }
    // Plans resume unless Linear stopped answering; one whose issue has
    // queued rows still waiting (held behind a rejected row) waits too, and
    // plans of every other issue go on.
    let completions = waiting();
    if (drained.stopped === undefined)
      try {
        completions = await resumeCompletions(this.deps, projectKey);
      } catch (error) {
        return {
          ...drained,
          stopped: error instanceof Error ? error.message : String(error),
          completions: waiting(),
        };
      }
    return { ...drained, completions };
  }

  /** Validates and runs one tool call; resolves to its JSON result or rejects with a BoardError. */
  async call(tool: string, argumentsValue: unknown): Promise<JsonObject> {
    if (!isToolName(tool))
      throw new BoardError("invalid", `unknown tool '${tool}'`);
    const project = z
      .object({ project_id: z.string() })
      .safeParse(argumentsValue);
    const key = project.success ? project.data.project_id : "";
    return this.serialize(key, async () => {
      try {
        return await this.dispatch(tool, argumentsValue);
      } catch (error) {
        if (isLinearError(error)) throw boardErrorFor(error);
        throw error;
      }
    });
  }

  private async mutate(
    tool: ToolName,
    request: { readonly project_id: string; readonly request_id: string },
    scope: string,
    run: () => Promise<object>,
  ): Promise<JsonObject> {
    const { store } = this.deps;
    const digest = createHash("sha256")
      .update(encode({ tool, request }))
      .digest("hex");
    const cached = store.receipt(scope, request.request_id);
    if (cached !== undefined) {
      if (cached.inputHash !== digest)
        throw new BoardError(
          "conflict",
          "request_id was already used with different input",
        );
      // A batch that failed part-way runs again (only what did not land).
      const stored = objectSchema.parse(cached.result);
      if (stored[PARTIAL] !== true) return stored;
    }
    const result = toJson(await run());
    // A batch where a change failed keeps only a marker of its input: a
    // retry with the same request id and the same changes re-applies only
    // what did not land, and the same id with other content is a conflict.
    const partial = failedResults.safeParse(result);
    const failedPart =
      partial.success &&
      partial.data.results.some((entry) => entry.outcome === "failed");
    if (failedPart) {
      store.putReceipt(scope, request.request_id, digest, { [PARTIAL]: true });
      return result;
    }
    if (
      result["dry_run"] !== true &&
      result["adoption_required"] !== true &&
      result["ready"] !== false
    ) {
      store.putReceipt(scope, request.request_id, digest, result);
      this.calls += 1;
      if (this.calls % 50 === 1) store.pruneReceipts(RECEIPT_RETENTION_DAYS);
    }
    return result;
  }

  private async dispatch(tool: ToolName, value: unknown): Promise<JsonObject> {
    const deps = this.deps;
    await this.drain(drainKey(value));
    const session = (request: { project_id: string; session_id: string }) =>
      `${request.project_id}:${request.session_id}`;
    switch (tool) {
      case "project_join": {
        const request = parseRequest(projectJoinSchema, value);
        return this.mutate(
          tool,
          request,
          `join:${encode([request.project_id, request.vendor, request.runtime, request.external_session_id])}`,
          () => projectJoin(deps, request),
        );
      }
      case "plan_publish": {
        const request = parseRequest(planPublishSchema, value);
        return this.mutate(tool, request, session(request), () =>
          planPublish(deps, request),
        );
      }
      case "plan_edit": {
        const request = parseRequest(planEditSchema, value);
        return this.mutate(tool, request, session(request), () =>
          planEdit(deps, request),
        );
      }
      case "plan_ack": {
        const request = parseRequest(planAckSchema, value);
        return this.mutate(tool, request, session(request), async () =>
          planAck(deps, request),
        );
      }
      case "issue_adopt": {
        const request = parseRequest(issueAdoptSchema, value);
        return this.mutate(tool, request, session(request), () =>
          issueAdopt(deps, request),
        );
      }
      case "work_claim": {
        const request = parseRequest(workClaimSchema, value);
        return this.mutate(tool, request, session(request), () =>
          workClaim(deps, request),
        );
      }
      case "work_update": {
        const request = parseRequest(workUpdateSchema, value);
        return this.mutate(tool, request, session(request), () =>
          workUpdate(deps, request),
        );
      }
      case "project_update": {
        const request = parseRequest(projectUpdateRequestSchema, value);
        return this.mutate(tool, request, session(request), () =>
          projectUpdate(deps, request),
        );
      }
      case "plan_read":
        return toJson(planRead(deps, parseRequest(planReadSchema, value)));
      case "project_status":
        return toJson(
          await projectStatus(deps, parseRequest(projectStatusSchema, value)),
        );
      case "work_history":
        return toJson(
          await workHistory(deps, parseRequest(workHistorySchema, value)),
        );
    }
  }

  /** Closes the local store. */
  close(): void {
    this.deps.store.close();
  }
}

export { MUTATIONS };
