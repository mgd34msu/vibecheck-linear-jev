// Test harness for the ledger: a Board on MemoryLinearApi and a temporary
// local store, optional scripted judgment, and helpers that join, publish,
// claim and update with the fewest fields each test needs.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { TestContext } from "node:test";
import { z } from "zod";
import { BoardError, type BoardErrorCode } from "../src/errors.js";
import { ScriptedProvider, type Script } from "../src/jev/lib/index.js";
import { projectKeyOf } from "../src/ledger/access.js";
import { Board, type JsonObject } from "../src/ledger/board.js";
import { MemoryLinearApi } from "../src/linear/memory.js";
import { SqliteLocalStore } from "../src/local/store.js";
import { LedgerVerifier } from "../src/verification/ledger.js";

export const PROJECT = "test";
/** PROJECT as a local store key. */
export const PROJECT_KEY = projectKeyOf(PROJECT);
export const request = () => `r-${randomUUID()}`;

export interface Ledger {
  readonly board: Board;
  readonly linear: MemoryLinearApi;
  readonly store: SqliteLocalStore;
  readonly path: string;
  readonly directory: string;
  readonly provider: ScriptedProvider | undefined;
}

export interface LedgerOptions {
  /** Scripted judgment; without it the ledger runs no checks. */
  readonly script?: Script;
  /** Calls the scripted provider fails before answering. */
  readonly failures?: number;
  /** Share another ledger's Linear (a second machine). */
  readonly linear?: MemoryLinearApi;
  readonly maxRechecks?: number;
  /** The board's clock (default: the real time). */
  readonly now?: () => Date;
  /** The checks are off by configuration (`ledger.verify: false`). */
  readonly checksOff?: boolean;
}

export function judgmentFor(provider: ScriptedProvider) {
  return {
    provider,
    config: {},
    thresholdsFor: () => undefined,
    sources: [],
    unusable: [],
  };
}

/** A board on a fresh store; the store and its folder go away after the test. */
export function createLedger(
  t: TestContext,
  options: LedgerOptions = {},
): Ledger {
  const directory = mkdtempSync(
    joinPath(tmpdir(), "vibecheck-linear-jev-test-"),
  );
  const path = joinPath(directory, "state.sqlite3");
  const store = new SqliteLocalStore(path);
  const linear = options.linear ?? new MemoryLinearApi();
  const provider =
    options.script === undefined
      ? undefined
      : new ScriptedProvider(options.script, "scripted", options.failures ?? 0);
  const board = new Board({
    store,
    linear,
    ...(provider === undefined
      ? {}
      : { verifier: new LedgerVerifier(judgmentFor(provider)) }),
    ...(options.maxRechecks === undefined
      ? {}
      : { config: { reconcile: { maxRechecks: options.maxRechecks } } }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.checksOff === undefined
      ? {}
      : { checksOff: options.checksOff }),
  });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { board, linear, store, path, directory, provider };
}

const joinedSchema = z.object({ session_id: z.string() });

export async function join(
  board: Board,
  name = "root",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await board.call("project_join", {
    project_id: PROJECT,
    request_id: request(),
    repository: "repo",
    vendor: "claude-code",
    runtime: "cli",
    external_session_id: name,
    model: "test-model",
    effort: "high",
    ...extra,
  });
  return joinedSchema.parse(result).session_id;
}

/** A minimal valid project definition. */
export const PROJECT_FIELDS = { name: "vc-test-ledger" };

export interface TaskInput {
  readonly key: string;
  readonly title: string;
  readonly [field: string]: unknown;
}

export async function publish(
  board: Board,
  sessionId: string,
  tasks: readonly TaskInput[] = [
    {
      key: "A-1",
      title: "First task",
      goal: "Do the first part of the work in full",
      criteria: ["the first part is done and tested"],
    },
    { key: "B-1", title: "Second task", depends_on: ["A-1"] },
  ],
  extra: Record<string, unknown> = {},
): Promise<JsonObject> {
  return acceptingProblems(board, "plan_publish", {
    project_id: PROJECT,
    request_id: request(),
    session_id: sessionId,
    expected_revision: 0,
    project: PROJECT_FIELDS,
    tasks,
    ...extra,
  });
}

const notReadySchema = z.object({
  ready: z.literal(false),
  problems: z.array(z.object({ id: z.string() })),
});

/**
 * Calls a plan tool and, when the first publish is not ready (ruling 12),
 * sends the same request again accepting every problem it named. For tests
 * whose subject is not plan readiness.
 */
export async function acceptingProblems(
  board: Board,
  tool: "plan_publish" | "plan_edit" | "issue_adopt",
  args: Record<string, unknown>,
): Promise<JsonObject> {
  const first = await board.call(tool, args);
  const notReady = notReadySchema.safeParse(first);
  if (!notReady.success || first["dry_run"] === true) return first;
  const earlier = z.array(z.string()).optional().parse(args["accept"]) ?? [];
  return board.call(tool, {
    ...args,
    accept: [
      ...earlier,
      ...notReady.data.problems.map((problem) => problem.id),
    ],
  });
}

const claimSchema = z.object({
  work: z.object({
    id: z.string(),
    task_id: z.string(),
    identifier: z.string(),
  }),
  issue: z.object({ id: z.string(), identifier: z.string() }),
  verification: z
    .array(
      z.object({ check: z.string(), outcome: z.string(), reason: z.string() }),
    )
    .optional(),
});

export async function claim(
  board: Board,
  sessionId: string,
  taskId: string,
  location: Record<string, unknown> = {},
) {
  return claimSchema.parse(
    await board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionId,
      task_id: taskId,
      location,
    }),
  );
}

export const updateSchema = z.object({
  work: z.array(z.object({ id: z.string(), status: z.string() })),
  tasks: z.array(z.object({ task_id: z.string(), status: z.string() })),
  verification: z
    .array(
      z.object({
        check: z.string(),
        outcome: z.string(),
        reason: z.string(),
        reported_status: z.string().optional(),
        applied_status: z.string().optional(),
      }),
    )
    .optional(),
  sync: z.object({ pending: z.number() }),
});

export async function update(
  board: Board,
  sessionId: string,
  workId: string,
  change: Record<string, unknown>,
) {
  return updateSchema.parse(
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: sessionId,
      updates: [{ work_id: workId, ...change }],
    }),
  );
}

export const statusSchema = z.object({
  plan_revision: z.number(),
  attention: z
    .array(
      z.object({
        kind: z.string(),
        check: z.string(),
        reason: z.string(),
        task_id: z.string().optional(),
        needs: z.string().optional(),
      }),
    )
    .optional(),
  tasks: z.record(
    z.string(),
    z.object({
      identifier: z.string(),
      status: z.string(),
      verified: z.string().optional(),
      owner_work_id: z.string().optional(),
    }),
  ),
  verification: z
    .record(
      z.string(),
      z.object({ verified: z.string(), reported: z.string() }),
    )
    .optional(),
  sync: z.object({
    pending: z.number(),
    pending_rechecks: z.number().optional(),
    pending_completions: z.number().optional(),
  }),
});

export async function status(
  board: Board,
  extra: Record<string, unknown> = {},
) {
  return statusSchema.parse(
    await board.call("project_status", {
      project_id: PROJECT,
      full: true,
      ...extra,
    }),
  );
}

export async function rejectsCode(
  operation: Promise<unknown>,
  code: BoardErrorCode,
  message?: RegExp,
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof BoardError, String(error));
    assert.equal(error.code, code, error.message);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

/** The BoardError an operation rejects with; fails when it resolves. */
export async function failureOf(
  operation: Promise<unknown>,
): Promise<BoardError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof BoardError, String(error));
    return error;
  }
  assert.fail("the operation succeeded");
}

/** One field of a BoardError's details. */
export function detail(error: BoardError, field: string): unknown {
  const details = error.details;
  return details === undefined || Array.isArray(details)
    ? undefined
    : details[field];
}

/** Label names on an issue. */
export async function labelNames(
  linear: MemoryLinearApi,
  identifier: string,
): Promise<string[]> {
  const issue = await linear.issue(identifier);
  assert.ok(issue !== null, `no issue ${identifier}`);
  const names = new Map(
    (await linear.labels(linear.teamId)).map((label) => [label.id, label.name]),
  );
  return issue.labelIds.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [name];
  });
}

/** Comment bodies on an issue, oldest first. */
export async function commentBodies(
  linear: MemoryLinearApi,
  identifier: string,
): Promise<string[]> {
  const issue = await linear.issue(identifier);
  assert.ok(issue !== null, `no issue ${identifier}`);
  return (await linear.comments(issue.id)).map((comment) => comment.body);
}
