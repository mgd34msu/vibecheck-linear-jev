// Hook plumbing shared by the hooks: payload schemas for the clients, the
// dependencies a hook needs, and the response shapes each client reads.
//
// Claude Code, Codex and Muse send one JSON object on stdin. All carry
// `session_id`, `cwd` and `transcript_path` (nullable on Codex and Muse);
// PreToolUse adds `tool_name` and `tool_input`; stopping events add
// `last_assistant_message` and `stop_hook_active`. Those three read a
// PreToolUse denial from `hookSpecificOutput.permissionDecision` and a stop
// block from `{"decision":"block","reason":...}` on stdout.
//
// Antigravity sends its own shapes, translated here to the shared payloads:
// PreToolUse carries `toolCall` with PascalCase args plus `conversationId`,
// `workspacePaths` and `transcriptPath`; Stop carries only the common
// fields, so the reply always comes from the transcript. Antigravity reads
// a PreToolUse answer from a flat `decision` of allow or deny and a stop
// block from `{"decision":"continue","reason":...}`; anything else lets the
// stop through.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import {
  renderVerdictComment,
  type CommentAuthor,
} from "../../linear/states.js";
import { SqliteLocalStore } from "../../local/store.js";
import type { ProjectKey } from "../../local/types.js";
import { antigravityBrainDir, museSessionsDir } from "../../paths.js";
import type { SqlAccess } from "../../sqlite.js";
import {
  appendEntry,
  type NewEntry,
  type Subject,
} from "../../verification/store.js";
import {
  antigravityPrompts,
  findAntigravityTranscript,
  findMuseSessionLog,
  readAntigravityTranscript,
  readMuseTranscript,
  readTranscript,
  type Client,
  type TranscriptView,
} from "../transcript.js";
import type { Judgment } from "../judgment.js";
import type { SourceSkip } from "../lib/index.js";

export const preToolPayloadSchema = z.looseObject({
  session_id: z.string().optional(),
  transcript_path: z.string().nullable().optional(),
  cwd: z.string().optional(),
  tool_name: z.string(),
  tool_input: z.unknown(),
});
export type PreToolPayload = z.infer<typeof preToolPayloadSchema>;

export const stopPayloadSchema = z.looseObject({
  session_id: z.string().optional(),
  child_session_id: z.string().optional(),
  subagent_id: z.string().optional(),
  transcript_path: z.string().nullable().optional(),
  cwd: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().nullable().optional(),
});
export type StopPayload = z.infer<typeof stopPayloadSchema>;

export interface HookResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

export type HookEvent = "PreToolUse" | "Stop" | "SubagentStop" | "SessionEnd";

export interface HookDeps {
  readonly client: Client;
  /** The local store (src/local/store.ts); hooks never call Linear. */
  readonly databasePath: string;
  /** Where Antigravity conversation stores live; the default brain when unset. */
  readonly antigravityBrain?: string;
  /** Where Muse session logs live; the default store when unset. */
  readonly sessionsDir?: string;
  /** The configured chain, or why none is usable. Called only when a check will run. */
  readonly judgment: () =>
    Judgment | { readonly unusable: readonly SourceSkip[] };
  /** The clock the Stop hook's reading budget runs on, in milliseconds; Date.now when unset. */
  readonly now?: () => number;
  /**
   * The Stop hook's budget in milliseconds: no reading starts after
   * `startMs`, and the hook answers (failing open) by `totalMs`. The
   * defaults are READING_START_BUDGET_MS and STOP_BUDGET_MS (stop.ts).
   */
  readonly stopBudget?: { readonly startMs: number; readonly totalMs: number };
}

const antigravityCommonSchema = z.looseObject({
  conversationId: z.string().optional(),
  workspacePaths: z.array(z.string()).optional(),
  transcriptPath: z.string().optional(),
});

const antigravityPreToolSchema = antigravityCommonSchema.extend({
  toolCall: z.looseObject({
    name: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
});

function antigravityArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** An Antigravity tool call flattened to the shared brief and command keys. */
function antigravityToolInput(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === "run_command") {
    const command = antigravityArg(args, "CommandLine");
    return command === undefined ? {} : { command };
  }
  if (name === "invoke_subagent") {
    const prompts = antigravityPrompts(args["Subagents"]);
    return prompts.length === 0 ? {} : { prompt: prompts.join("\n\n") };
  }
  if (name === "send_message") {
    const message = antigravityArg(args, "Message");
    const to = antigravityArg(args, "Recipient");
    return {
      ...(message === undefined ? {} : { message }),
      ...(to === undefined ? {} : { to }),
    };
  }
  if (name === "manage_task") {
    if (antigravityArg(args, "Action") !== "send_input") return {};
    const message = antigravityArg(args, "Input");
    const to = antigravityArg(args, "TaskId");
    return {
      ...(message === undefined ? {} : { message }),
      ...(to === undefined ? {} : { to }),
    };
  }
  return {};
}

function antigravitySession(wire: {
  readonly conversationId?: string | undefined;
  readonly workspacePaths?: readonly string[] | undefined;
  readonly transcriptPath?: string | undefined;
}): Pick<PreToolPayload, "session_id" | "cwd" | "transcript_path"> {
  return {
    ...(wire.conversationId === undefined
      ? {}
      : { session_id: wire.conversationId }),
    ...(wire.workspacePaths?.[0] === undefined
      ? {}
      : { cwd: wire.workspacePaths[0] }),
    ...(wire.transcriptPath === undefined
      ? {}
      : { transcript_path: wire.transcriptPath }),
  };
}

export function translateAntigravityPreTool(
  text: string,
): PreToolPayload | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "hook input is not JSON";
  }
  const wire = antigravityPreToolSchema.safeParse(value);
  if (!wire.success)
    return `hook input is missing fields: ${wire.error.issues.map((issue) => issue.path.join(".")).join(", ")}`;
  return {
    ...antigravitySession(wire.data),
    tool_name: wire.data.toolCall.name,
    tool_input: antigravityToolInput(
      wire.data.toolCall.name,
      wire.data.toolCall.args ?? {},
    ),
  };
}

export function translateAntigravityStop(text: string): StopPayload | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "hook input is not JSON";
  }
  const wire = antigravityCommonSchema.safeParse(value);
  if (!wire.success)
    return `hook input is missing fields: ${wire.error.issues.map((issue) => issue.path.join(".")).join(", ")}`;
  return antigravitySession(wire.data);
}

export function parsePayload<T>(
  schema: z.ZodType<T>,
  text: string,
): T | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "hook input is not JSON";
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? parsed.data
    : `hook input is missing fields: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`;
}

/** Nothing to say: the tool call or the stop goes ahead. */
export function allow(client: Client, event: HookEvent): HookResult {
  if (client === "antigravity")
    return event === "PreToolUse"
      ? { stdout: JSON.stringify({ decision: "allow" }), exitCode: 0 }
      : { stdout: "{}", exitCode: 0 };
  if (client === "muse") return { exitCode: 0 };
  return event === "Stop" && client === "codex"
    ? { stdout: "{}", exitCode: 0 }
    : { exitCode: 0 };
}

/**
 * A check could not run. The hook fails open: the work goes ahead and the
 * reason goes to stderr. Claude Code shows a non-zero, non-2 exit as a
 * non-blocking error; Codex expects valid JSON from Stop and a zero exit,
 * and Muse a zero exit. Antigravity answers PreToolUse with an explicit
 * allow and Stop with an empty object.
 */
export function failOpen(
  client: Client,
  event: HookEvent,
  message: string,
): HookResult {
  const stderr = `vibecheck-linear-jev: ${message}\n`;
  if (client === "antigravity")
    return event === "PreToolUse"
      ? { stdout: JSON.stringify({ decision: "allow" }), stderr, exitCode: 0 }
      : { stdout: "{}", stderr, exitCode: 0 };
  if (client === "muse") return { stderr, exitCode: 0 };
  if (client === "codex")
    return {
      ...(event === "Stop" ? { stdout: "{}" } : {}),
      stderr,
      exitCode: 0,
    };
  return { stderr, exitCode: 1 };
}

/** The session's transcript: Muse names no file, so its log is found by session id, and Antigravity falls back to its brain store. A missing or unreadable log reads as nothing to check against. */
export function readHookTranscript(
  deps: HookDeps,
  payload: {
    readonly transcript_path?: string | null | undefined;
    readonly session_id?: string | undefined;
    readonly child_session_id?: string | undefined;
  },
): TranscriptView | undefined {
  if (deps.client === "antigravity") {
    if (typeof payload.transcript_path === "string") {
      try {
        return readTranscript(payload.transcript_path, deps.client);
      } catch {
        // fall through to the brain lookup
      }
    }
    if (payload.session_id === undefined) return undefined;
    const found = findAntigravityTranscript(
      deps.antigravityBrain ?? antigravityBrainDir(),
      payload.session_id,
    );
    if (found === undefined) return undefined;
    try {
      return readAntigravityTranscript(found);
    } catch {
      return undefined;
    }
  }
  if (deps.client !== "muse")
    return typeof payload.transcript_path === "string"
      ? readTranscript(payload.transcript_path, deps.client)
      : undefined;
  const explicit = payload.transcript_path;
  if (typeof explicit === "string" && existsSync(explicit)) {
    try {
      return readMuseTranscript(explicit);
    } catch {
      return undefined;
    }
  }
  const sessionId = payload.session_id ?? payload.child_session_id;
  if (sessionId === undefined) return undefined;
  const found = findMuseSessionLog(
    deps.sessionsDir ?? museSessionsDir(),
    sessionId,
  );
  if (found === undefined) return undefined;
  try {
    return readMuseTranscript(found);
  } catch {
    return undefined;
  }
}

export function deny(client: Client, reason: string): HookResult {
  if (client === "antigravity")
    return {
      stdout: JSON.stringify({ decision: "deny", reason }),
      exitCode: 0,
    };
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

export function blockStop(client: Client, reason: string): HookResult {
  if (client === "antigravity")
    return {
      stdout: JSON.stringify({ decision: "continue", reason }),
      exitCode: 0,
    };
  return {
    stdout: JSON.stringify({ decision: "block", reason }),
    exitCode: 0,
  };
}

/** Where a blocking hook's verdicts are posted in Linear, through the outbox. */
export interface HookComment {
  readonly projectKey: ProjectKey;
  readonly issueId: string;
  readonly author: CommentAuthor;
  /**
   * Labels to add to the issue, by name: hooks cannot look label ids up, so
   * the outbox drain resolves each name (creating a missing `vc:*` label).
   */
  readonly labels?: readonly string[];
}

/**
 * Writes a hook's entries to the local store and, when `comment` names an
 * issue, queues one verdict comment per failed or flagged check and the
 * comment's labels (by name) for the outbox (the next tool call or `sync`
 * sends them). Label rows carry `skipIfCompleted: true`: the drain skips
 * one whose issue is completed or canceled by the time it is sent. All
 * entries of one call share one timestamp. A write failure never changes the
 * hook's answer.
 */
export async function recordEntries(
  databasePath: string,
  entries: readonly { readonly subject: Subject; readonly entry: NewEntry }[],
  comment?: HookComment,
): Promise<string | undefined> {
  if (entries.length === 0) return undefined;
  let store: SqliteLocalStore | undefined;
  try {
    const opened = new SqliteLocalStore(databasePath);
    store = opened;
    // One timestamp for the whole write: the Stop hook counts its blocks by
    // distinct entry times, so a block whose entries straddled a
    // millisecond would otherwise count twice.
    const live = opened.verificationAccess();
    const access: SqlAccess = { ...live, now: live.now };
    opened.transaction(() => {
      for (const { subject, entry } of entries)
        appendEntry(access, subject, entry);
      if (comment === undefined) return;
      const posted = new Set<string>();
      for (const { entry } of entries) {
        if (entry.kind !== "verdict") continue;
        const { battery_id: check, outcome, reason } = entry.body;
        if (
          (outcome !== "failed" && outcome !== "flagged") ||
          posted.has(check)
        )
          continue;
        posted.add(check);
        opened.enqueue({
          projectKey: comment.projectKey,
          kind: "comment",
          payload: {
            id: randomUUID(),
            issueId: comment.issueId,
            body: renderVerdictComment(comment.author, check, outcome, reason),
          },
        });
      }
      for (const labelName of new Set(comment.labels ?? []))
        opened.enqueue({
          projectKey: comment.projectKey,
          kind: "add_label",
          // The issue may be completed (verified) before the drain sends
          // this row; the drain then skips it rather than label done work.
          payload: {
            issueId: comment.issueId,
            labelName,
            skipIfCompleted: true,
          },
        });
    });
    return undefined;
  } catch (error) {
    return `could not record verdicts: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    store?.close();
  }
}

/** The comment target for a hook in a ledger context: the one claimed issue, if there is exactly one. */
export function hookComment(
  context:
    | {
        readonly projectId: ProjectKey;
        readonly session?:
          | {
              readonly id: string;
              readonly vendor: string;
              readonly model: string;
            }
          | undefined;
        readonly claimed: readonly { readonly issueId: string }[];
      }
    | undefined,
): HookComment | undefined {
  const only = context?.claimed.length === 1 ? context.claimed[0] : undefined;
  if (
    context === undefined ||
    only === undefined ||
    context.session === undefined
  )
    return undefined;
  return {
    projectKey: context.projectId,
    issueId: only.issueId,
    author: {
      vendor: context.session.vendor,
      model: context.session.model,
      sessionId: context.session.id,
    },
  };
}

/** The text of a string field in an unknown tool input. */
export function inputString(
  input: unknown,
  ...keys: string[]
): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  for (const key of keys) {
    const value = Object.entries(input).find(([name]) => name === key)?.[1];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
