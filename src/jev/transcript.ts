// Reads a session transcript into what the checks need: the user's messages,
// the agent's latest reply, what started the turn, and the tool results the
// reply's claims can be checked against.
//
// Claude Code writes one JSON entry per line with `type` user or assistant
// and a `message` whose content is text or blocks (text, tool_use,
// tool_result). Codex writes rollout lines `{ timestamp, type, payload }`:
// user input arrives as `event_msg` user_message or item_completed
// UserMessage events, replies as `response_item` messages with role
// assistant, tool calls as function_call or custom_tool_call items and their
// results as the matching *_output items. Lines that do not parse are skipped.
//
// Muse writes session.jsonl envelopes `{ payload: { kind, event } }`, some
// grouped in transaction frames whose children carry `record_json` strings.
// User input arrives as `started` prompts, replies as
// `assistant_message_committed` texts, tool calls as
// `assistant_tool_calls_committed` entries with JSON args and their results
// as `tool_result_batch_committed` texts.
//
// Antigravity writes JSONL steps `{ source, type, content?, thinking?,
// tool_calls? }`. User text arrives as USER_EXPLICIT/USER_INPUT content
// wrapped in uppercase section tags; replies as MODEL PLANNER_RESPONSE
// content; commands and subagent briefs as tool_calls; command output and
// injected documents as MODEL GENERIC content. The compact transcript
// JSON-encodes its values while the full one writes them plain; both read
// the same. Reasoning in `thinking` is never a reply.
//
// Recognizing harness-inserted text (reminders, notices, injected context)
// matches the fixed markers each client writes; it does not read prose.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type Client = "claude" | "codex" | "muse" | "antigravity";
export type TurnTrigger = "user" | "notification";

export interface TranscriptView {
  readonly userMessages: readonly string[];
  /** Every reply text since the user's last message. */
  readonly lastReply: string | undefined;
  /** The reply text after the turn's last tool result. */
  readonly finalText: string | undefined;
  readonly trigger: TurnTrigger;
  /**
   * Tool results and commands from the whole session, one segment each, up
   * to EVIDENCE_POOL characters. First come the lead results (the newest
   * tool result of each of the last LEAD_TURNS turns, then the final turn's
   * other newest results, at most LEAD_SEGMENTS, newest first), then every
   * other segment newest first. A claim in the final reply usually rests on
   * the latest output, and often on output an earlier turn produced.
   */
  readonly evidence: readonly string[];
}

/** A long command is clipped; its first lines say what it does. */
const COMMAND_LIMIT = 1_200;
/** Evidence kept per reading, newest characters first. */
export const EVIDENCE_LIMIT = 60_000;
/**
 * Evidence characters a view keeps, newest first, from which a reading takes
 * EVIDENCE_LIMIT with the claimed files first: room for an older segment
 * about a claimed file to move ahead of newer ones.
 */
export const EVIDENCE_POOL = 4 * EVIDENCE_LIMIT;
/**
 * One tool result is clipped to this many characters, keeping its head and
 * its tail (where a command prints its summary), so one large output cannot
 * crowd the rest of the session out of a reading.
 */
export const SEGMENT_LIMIT = 16_000;
const SEGMENT_TAIL = 4_000;
/** Turns whose newest tool result leads every reading. */
export const LEAD_TURNS = 4;
/** Lead segments at most: the LEAD_TURNS turns' newest results, then more of the final turn's. */
export const LEAD_SEGMENTS = 6;
/** A lead segment is clipped to this many characters in a reading, most of them from its tail. */
export const LEAD_LIMIT = 5_000;
const LEAD_TAIL = 3_500;

/** A segment clipped to `limit` characters, head and tail kept. */
export function clipSegment(
  segment: string,
  limit = SEGMENT_LIMIT,
  tail = SEGMENT_TAIL,
): string {
  if (segment.length <= limit) return segment;
  const head = limit - tail;
  return `${segment.slice(0, head)}\n[... ${segment.length - limit} characters clipped ...]\n${segment.slice(-tail)}`;
}

interface EvidenceSegment {
  readonly text: string;
  /** The user turn it belongs to (a count of user messages so far). */
  readonly turn: number;
  /** A tool result or harness notice, as opposed to a command run. */
  readonly result: boolean;
}

class ViewBuilder {
  readonly userMessages: string[] = [];
  lastReply: string | undefined;
  finalText: string | undefined;
  trigger: TurnTrigger = "user";
  /** Every evidence segment of the session, oldest first. */
  readonly #evidence: EvidenceSegment[] = [];
  #turn = 0;

  user(text: string): void {
    if (this.userMessages.at(-1) === text && this.lastReply === undefined)
      return;
    this.userMessages.push(text);
    this.#turn += 1;
    this.lastReply = undefined;
    this.finalText = undefined;
    this.trigger = "user";
  }

  notice(text: string): void {
    this.lastReply = undefined;
    this.finalText = undefined;
    this.trigger = "notification";
    this.#evidence.push({ text, turn: this.#turn, result: true });
  }

  /** After a Stop-hook block the corrected reply is what follows the feedback. */
  resetReply(): void {
    this.lastReply = undefined;
    this.finalText = undefined;
  }

  /** A display form replaces the prompt it renders. */
  replaceLastUser(text: string): void {
    if (this.userMessages.length === 0) {
      this.user(text);
      return;
    }
    this.userMessages[this.userMessages.length - 1] = text;
  }

  reply(text: string): void {
    this.lastReply =
      this.lastReply === undefined ? text : `${this.lastReply}\n${text}`;
    this.finalText =
      this.finalText === undefined ? text : `${this.finalText}\n${text}`;
  }

  toolResult(text: string): void {
    this.#evidence.push({ text, turn: this.#turn, result: true });
    this.finalText = undefined;
  }

  toolCall(text: string): void {
    this.#evidence.push({ text, turn: this.#turn, result: false });
  }

  /** Indexes of the lead results, newest first. */
  #leads(): number[] {
    const segments = this.#evidence;
    const leads: number[] = [];
    const turns = new Set<number>();
    for (let index = segments.length - 1; index >= 0; index--) {
      const segment = segments[index];
      if (segment === undefined || !segment.result || turns.has(segment.turn))
        continue;
      if (turns.size >= LEAD_TURNS) break;
      turns.add(segment.turn);
      leads.push(index);
    }
    const final = segments.findLast((segment) => segment.result)?.turn;
    for (let index = segments.length - 1; index >= 0; index--) {
      if (leads.length >= LEAD_SEGMENTS) break;
      const segment = segments[index];
      if (segment === undefined || segment.turn !== final) break;
      if (segment.result && !leads.includes(index)) leads.push(index);
    }
    return leads.sort((left, right) => right - left);
  }

  build(): TranscriptView {
    const evidence: string[] = [];
    let kept = 0;
    const leads = this.#leads();
    for (const index of leads) {
      const segment = clipSegment(this.#evidence[index]?.text ?? "");
      evidence.push(segment);
      kept += segment.length;
    }
    const lead = new Set(leads);
    for (let index = this.#evidence.length - 1; index >= 0; index--) {
      if (kept >= EVIDENCE_POOL) break;
      if (lead.has(index)) continue;
      const segment = clipSegment(this.#evidence[index]?.text ?? "");
      evidence.push(segment);
      kept += segment.length;
    }
    return {
      userMessages: this.userMessages,
      lastReply: this.lastReply,
      finalText: this.finalText,
      trigger: this.trigger,
      evidence,
    };
  }
}

function lines(path: string): unknown[] {
  const values: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // a partial last line while the client is still writing
    }
  }
  return values;
}

function commandText(command: string, description?: string): string {
  return `${description === undefined ? "Command run:" : `Command run (${description}):`}\n$ ${command.slice(0, COMMAND_LIMIT)}`;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const claudeBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  content: z.unknown().optional(),
});
type ClaudeBlock = z.infer<typeof claudeBlockSchema>;

const claudeEntrySchema = z.looseObject({
  type: z.string(),
  message: z
    .looseObject({
      role: z.string().optional(),
      content: z.union([z.string(), z.array(z.unknown())]).optional(),
    })
    .optional(),
});

function claudeBlocks(content: unknown): ClaudeBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const parsed = claudeBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

function claudeText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  const texts = claudeBlocks(content)
    .filter((block) => block.type === "text" && block.text !== undefined)
    .map((block) => block.text ?? "");
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function claudeToolResult(content: unknown): string | undefined {
  const parts: string[] = [];
  for (const block of claudeBlocks(content)) {
    if (block.type !== "tool_result") continue;
    if (typeof block.content === "string") parts.push(block.content);
    else
      for (const inner of claudeBlocks(block.content))
        if (inner.text !== undefined) parts.push(inner.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function stringInput(block: ClaudeBlock, key: string): string | undefined {
  const value = block.input?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Commands and instructions an assistant entry sent: what its claims about running work rest on. */
function claudeToolCalls(content: unknown): string[] {
  const parts: string[] = [];
  for (const block of claudeBlocks(content)) {
    if (block.type !== "tool_use") continue;
    const command = stringInput(block, "command");
    if (block.name === "Bash" && command !== undefined) {
      parts.push(commandText(command, stringInput(block, "description")));
      continue;
    }
    if (
      block.name !== "Agent" &&
      block.name !== "Task" &&
      block.name !== "SendMessage"
    )
      continue;
    const text = stringInput(block, "prompt") ?? stringInput(block, "message");
    if (text !== undefined)
      parts.push(`Instruction sent by ${block.name}: ${text}`);
  }
  return parts;
}

const CLAUDE_HARNESS_MARKERS = [
  "<system-reminder>",
  "<task-notification>",
  "[SYSTEM NOTIFICATION",
  "Stop hook feedback",
  "<command-",
  "<local-command-",
];

function claudeIsNotice(text: string): boolean {
  const start = text.trimStart();
  return (
    start.startsWith("<task-notification>") ||
    start.startsWith("[SYSTEM NOTIFICATION") ||
    (start.startsWith("<system-reminder>") &&
      start.includes("<task-notification>"))
  );
}

export function readClaudeTranscript(path: string): TranscriptView {
  const view = new ViewBuilder();
  for (const value of lines(path)) {
    const parsed = claudeEntrySchema.safeParse(value);
    if (!parsed.success) continue;
    const entry = parsed.data;
    const content = entry.message?.content;
    if (entry.type === "user") {
      const result = claudeToolResult(content);
      if (result !== undefined) view.toolResult(result);
    }
    if (entry.type === "assistant")
      for (const call of claudeToolCalls(content)) view.toolCall(call);
    const text = claudeText(content);
    if (text === undefined) continue;
    if (entry.type === "user") {
      const start = text.trimStart();
      if (claudeIsNotice(text)) view.notice(text);
      else if (start.startsWith("Stop hook feedback")) view.resetReply();
      else if (
        start.length > 0 &&
        !CLAUDE_HARNESS_MARKERS.some((marker) => start.startsWith(marker))
      )
        view.user(text);
    }
    if (entry.type === "assistant") view.reply(text);
  }
  return view.build();
}

/** The prompt an agent was launched with, found by the agent id its launch result names. */
export function claudeLaunchBrief(
  path: string,
  agentId: string,
): string | undefined {
  const briefs = new Map<string, string>();
  let found: string | undefined;
  for (const value of lines(path)) {
    const parsed = claudeEntrySchema.safeParse(value);
    if (!parsed.success) continue;
    for (const block of claudeBlocks(parsed.data.message?.content)) {
      const prompt = stringInput(block, "prompt");
      if (
        block.type === "tool_use" &&
        (block.name === "Agent" || block.name === "Task") &&
        prompt !== undefined &&
        block.id !== undefined
      )
        briefs.set(block.id, prompt);
      if (
        block.type === "tool_result" &&
        block.tool_use_id !== undefined &&
        JSON.stringify(block.content ?? "").includes(agentId)
      )
        found = briefs.get(block.tool_use_id) ?? found;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const codexLineSchema = z.looseObject({
  type: z.string(),
  payload: z.unknown(),
});
const codexPayloadSchema = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  message: z.unknown().optional(),
  content: z.unknown().optional(),
  output: z.unknown().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  input: z.string().optional(),
  item: z.unknown().optional(),
  replacement_history: z.array(z.unknown()).optional(),
  author: z.string().optional(),
});
const codexItemSchema = z.looseObject({
  type: z.string(),
  content: z.array(z.looseObject({ text: z.string().optional() })).optional(),
});
const codexContentSchema = z.array(
  z.looseObject({ type: z.string().optional(), text: z.string().optional() }),
);

function codexText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  const parsed = codexContentSchema.safeParse(content);
  if (!parsed.success) return undefined;
  const texts = parsed.data.flatMap((part) =>
    part.text === undefined ? [] : [part.text],
  );
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Context Codex injects as user-role messages; the user's own input arrives as events. */
const CODEX_INJECTED_MARKERS = [
  "<environment_context>",
  "<recommended_plugins>",
  "<user_instructions>",
  "<permissions",
  "<skills",
  "# AGENTS.md",
];

const codexArgumentsSchema = z.looseObject({
  cmd: z.union([z.string(), z.array(z.string())]).optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  message: z.string().optional(),
});

function codexCommand(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.join(" ");
}

export function readCodexTranscript(path: string): TranscriptView {
  const view = new ViewBuilder();
  let sawUserEvents = false;
  const entries = lines(path).flatMap((value) => {
    const line = codexLineSchema.safeParse(value);
    if (!line.success) return [];
    const payload = codexPayloadSchema.safeParse(line.data.payload);
    return payload.success
      ? [{ type: line.data.type, payload: payload.data }]
      : [];
  });
  for (const { type, payload } of entries)
    if (
      type === "event_msg" &&
      (payload.type === "user_message" ||
        (payload.type === "item_completed" &&
          codexItemSchema.safeParse(payload.item).data?.type === "UserMessage"))
    )
      sawUserEvents = true;
  for (const { type, payload } of entries) {
    if (type === "compacted") {
      for (const message of payload.replacement_history ?? []) {
        const parsed = codexPayloadSchema.safeParse(message);
        if (!parsed.success || parsed.data.role !== "user") continue;
        const text = codexText(parsed.data.content);
        if (
          text !== undefined &&
          !CODEX_INJECTED_MARKERS.some((marker) =>
            text.trimStart().startsWith(marker),
          )
        )
          view.user(text);
      }
      continue;
    }
    if (type === "event_msg") {
      if (
        payload.type === "user_message" &&
        typeof payload.message === "string"
      ) {
        view.user(payload.message);
        continue;
      }
      if (payload.type === "item_completed") {
        const item = codexItemSchema.safeParse(payload.item);
        if (item.success && item.data.type === "UserMessage") {
          const text = (item.data.content ?? [])
            .flatMap((part) => (part.text === undefined ? [] : [part.text]))
            .join("\n");
          if (text.length > 0) view.user(text);
        }
      }
      continue;
    }
    if (type !== "response_item") continue;
    switch (payload.type) {
      case "message": {
        const text = codexText(payload.content);
        if (text === undefined) break;
        if (payload.role === "assistant") view.reply(text);
        else if (
          payload.role === "user" &&
          !sawUserEvents &&
          !CODEX_INJECTED_MARKERS.some((marker) =>
            text.trimStart().startsWith(marker),
          )
        )
          view.user(text);
        break;
      }
      case "agent_message": {
        const text = codexText(payload.content);
        if (text !== undefined) view.notice(text);
        break;
      }
      case "function_call": {
        const args = codexArgumentsSchema.safeParse(
          safeJson(payload.arguments ?? ""),
        );
        const command = codexCommand(args.data?.cmd ?? args.data?.command);
        if (command !== undefined) view.toolCall(commandText(command));
        else if (
          args.data?.message !== undefined &&
          !isSealed(args.data.message)
        )
          view.toolCall(
            `Instruction sent by ${payload.name ?? "a tool"}: ${args.data.message}`,
          );
        break;
      }
      case "custom_tool_call":
        if (payload.input !== undefined)
          view.toolCall(commandText(payload.input));
        break;
      case "function_call_output":
      case "custom_tool_call_output": {
        const text = codexText(payload.output);
        if (text !== undefined && text.length > 0) view.toolResult(text);
        break;
      }
      default:
        break;
    }
  }
  return view.build();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Codex stores agent-to-agent messages as sealed Fernet tokens (version byte
 * 0x80, which base64url-encodes to a leading "gAAAAA"). A sealed brief cannot
 * be read, so no check runs on it.
 */
export function isSealed(text: string): boolean {
  return /^gAAAAA[A-Za-z0-9_-]+=*$/u.test(text.trim());
}

// ---------------------------------------------------------------------------
// Muse
// ---------------------------------------------------------------------------

const museRecordSchema = z.looseObject({
  children: z.array(z.unknown()).optional(),
  payload: z.unknown().optional(),
});
const museChildSchema = z.looseObject({ record_json: z.string() });
const musePayloadSchema = z.looseObject({ event: z.unknown().optional() });
const museEventSchema = z.looseObject({
  kind: z.string(),
  prompt: z.string().optional(),
  text: z.string().optional(),
  body: z.unknown().optional(),
  payload: z.unknown().optional(),
  source: z.unknown().optional(),
  lifecycle: z.string().optional(),
  tool_calls: z.unknown().optional(),
  results: z.unknown().optional(),
});
type MuseEvent = z.infer<typeof museEventSchema>;
const museToolCallSchema = z.looseObject({
  name: z.string().optional(),
  args: z.string().optional(),
});
const museToolResultSchema = z.looseObject({ text: z.string().optional() });
const museInboxSourceSchema = z.looseObject({ source: z.string().optional() });
const museInboxPayloadSchema = z.looseObject({ prompt: z.string().optional() });
const museBashArgsSchema = z.looseObject({
  command: z.string().optional(),
  description: z.string().optional(),
});
const museSpawnArgsSchema = z.looseObject({
  objective: z.string().optional(),
});

/** Every record a Muse session log line holds: the line itself, plus the records a transaction frame carries. */
function museRecords(value: unknown): unknown[] {
  const parsed = museRecordSchema.safeParse(value);
  if (!parsed.success) return [];
  const records: unknown[] = [value];
  for (const child of parsed.data.children ?? []) {
    const inner = museChildSchema.safeParse(child);
    if (!inner.success) continue;
    try {
      records.push(JSON.parse(inner.data.record_json));
    } catch {
      // a partial child while the client is still writing
    }
  }
  return records;
}

function museEventOf(record: unknown): MuseEvent | undefined {
  const parsed = museRecordSchema.safeParse(record);
  if (!parsed.success) return undefined;
  const payload = musePayloadSchema.safeParse(parsed.data.payload);
  if (!payload.success) return undefined;
  const event = museEventSchema.safeParse(payload.data.event);
  return event.success ? event.data : undefined;
}

/** A queued delivery's text: the prompt it carries, or the body when it carries none. */
function museInboxText(event: MuseEvent): string | undefined {
  const nested = museInboxPayloadSchema.safeParse(event.payload);
  if (nested.success && nested.data.prompt !== undefined)
    return nested.data.prompt;
  return typeof event.body === "string" ? event.body : undefined;
}

function museInboxSource(event: MuseEvent): string | undefined {
  const parsed = museInboxSourceSchema.safeParse(event.source);
  return parsed.success ? parsed.data.source : undefined;
}

/** Commands and instructions an assistant entry sent: what its claims about running work rest on. */
function museToolCalls(event: MuseEvent): string[] {
  if (!Array.isArray(event.tool_calls)) return [];
  const calls: string[] = [];
  for (const item of event.tool_calls) {
    const parsed = museToolCallSchema.safeParse(item);
    if (!parsed.success || parsed.data.args === undefined) continue;
    let args: unknown;
    try {
      args = JSON.parse(parsed.data.args);
    } catch {
      continue;
    }
    if (parsed.data.name === "bash") {
      const bash = museBashArgsSchema.safeParse(args);
      if (bash.success && bash.data.command !== undefined)
        calls.push(commandText(bash.data.command, bash.data.description));
    } else if (parsed.data.name === "subagent_spawn") {
      const spawn = museSpawnArgsSchema.safeParse(args);
      if (spawn.success && spawn.data.objective !== undefined)
        calls.push(
          `Instruction sent by subagent_spawn: ${spawn.data.objective}`,
        );
    }
  }
  return calls;
}

function museToolResults(event: MuseEvent): string[] {
  if (!Array.isArray(event.results)) return [];
  const texts: string[] = [];
  for (const item of event.results) {
    const parsed = museToolResultSchema.safeParse(item);
    if (
      parsed.success &&
      parsed.data.text !== undefined &&
      parsed.data.text.length > 0
    )
      texts.push(parsed.data.text);
  }
  return texts;
}

function readMuseEvent(view: ViewBuilder, event: MuseEvent): void {
  switch (event.kind) {
    case "started": {
      if (event.prompt !== undefined) view.user(event.prompt);
      break;
    }
    case "user_prompt_display": {
      if (event.text !== undefined) view.replaceLastUser(event.text);
      break;
    }
    case "inbox_item_queued": {
      const text = museInboxText(event);
      if (text === undefined) break;
      if (museInboxSource(event) === "user_steer") view.user(text);
      else view.notice(text);
      break;
    }
    case "assistant_message_committed": {
      if (event.text !== undefined) view.reply(event.text);
      break;
    }
    case "assistant_tool_calls_committed": {
      for (const call of museToolCalls(event)) view.toolCall(call);
      break;
    }
    case "tool_result_batch_committed": {
      for (const result of museToolResults(event)) view.toolResult(result);
      break;
    }
    case "context_block_updated": {
      if (event.lifecycle === "subagent_stop") view.resetReply();
      break;
    }
    default:
      break;
  }
}

export function readMuseTranscript(path: string): TranscriptView {
  const view = new ViewBuilder();
  for (const value of lines(path)) {
    for (const record of museRecords(value)) {
      const event = museEventOf(record);
      if (event !== undefined) readMuseEvent(view, event);
    }
  }
  return view.build();
}

function readDir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** The session log in one day folder: the session's own, or a child's beside its parent. */
function museLogIn(dayDir: string, sessionId: string): string | undefined {
  const direct = join(dayDir, sessionId, "session.jsonl");
  if (existsSync(direct)) return direct;
  for (const name of readDir(dayDir)) {
    const child = join(dayDir, name, "subagent", sessionId, "session.jsonl");
    if (existsSync(child)) return child;
  }
  return undefined;
}

/** A Muse session id carries its creation time, so its log usually sits in that local day's folder. */
function museLogDay(sessionId: string): string | undefined {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      sessionId,
    )
  )
    return undefined;
  const created = new Date(
    Number.parseInt(sessionId.slice(0, 8) + sessionId.slice(9, 13), 16),
  );
  if (Number.isNaN(created.getTime())) return undefined;
  const day = (value: number): string => String(value).padStart(2, "0");
  return `${created.getFullYear()}/${day(created.getMonth() + 1)}/${day(created.getDate())}`;
}

/** The session log for a Muse session id: the day's folder first, then the whole store. */
export function findMuseSessionLog(
  sessionsDir: string,
  sessionId: string,
): string | undefined {
  const day = museLogDay(sessionId);
  if (day !== undefined) {
    const found = museLogIn(join(sessionsDir, day), sessionId);
    if (found !== undefined) return found;
  }
  for (const year of readDir(sessionsDir))
    for (const month of readDir(join(sessionsDir, year)))
      for (const dayName of readDir(join(sessionsDir, year, month))) {
        const found = museLogIn(
          join(sessionsDir, year, month, dayName),
          sessionId,
        );
        if (found !== undefined) return found;
      }
  return undefined;
}

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

const antigravityStepSchema = z.looseObject({
  source: z.string().optional(),
  type: z.string().optional(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
});
const antigravityToolCallSchema = z.looseObject({
  name: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});
const antigravitySubagentSchema = z.looseObject({
  Prompt: z.string().optional(),
});

/** Step values in the compact transcript are JSON-encoded; the full transcript writes them plain. */
function antigravityValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return value;
  try {
    const decoded: unknown = JSON.parse(trimmed);
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

function antigravityList(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** The brief texts of an invoke_subagent call: one prompt per subagent. */
export function antigravityPrompts(value: unknown): string[] {
  const list = antigravityList(value);
  if (list === undefined) return [];
  const prompts: string[] = [];
  for (const item of list) {
    const parsed = antigravitySubagentSchema.safeParse(item);
    const prompt = parsed.success
      ? antigravityValue(parsed.data.Prompt)
      : undefined;
    if (prompt !== undefined && prompt.length > 0) prompts.push(prompt);
  }
  return prompts;
}

/** Commands and instructions a step sent: what its claims about running work rest on. */
function antigravityToolCalls(calls: readonly unknown[] | undefined): string[] {
  if (calls === undefined) return [];
  const parts: string[] = [];
  for (const item of calls) {
    const parsed = antigravityToolCallSchema.safeParse(item);
    if (!parsed.success) continue;
    const args = parsed.data.args ?? {};
    if (parsed.data.name === "run_command") {
      const command = antigravityValue(args["CommandLine"]);
      if (command !== undefined)
        parts.push(commandText(command, antigravityValue(args["toolSummary"])));
      continue;
    }
    if (parsed.data.name === "invoke_subagent") {
      for (const prompt of antigravityPrompts(args["Subagents"]))
        parts.push(`Instruction sent by invoke_subagent: ${prompt}`);
      continue;
    }
    if (parsed.data.name === "send_message") {
      const message = antigravityValue(args["Message"]);
      if (message !== undefined)
        parts.push(`Instruction sent by send_message: ${message}`);
      continue;
    }
    if (parsed.data.name === "manage_task") {
      const input = antigravityValue(args["Input"]);
      if (input !== undefined)
        parts.push(`Instruction sent by manage_task: ${input}`);
    }
  }
  return parts;
}

/** User content wraps sections in mismatched uppercase tags; the request is the text without them. */
function antigravityUserText(content: string): string | undefined {
  const text = content.replace(/<\/?[A-Z][A-Z0-9_]*>/gu, "").trim();
  return text.length > 0 ? text : undefined;
}

export function readAntigravityTranscript(path: string): TranscriptView {
  const view = new ViewBuilder();
  for (const value of lines(path)) {
    const parsed = antigravityStepSchema.safeParse(value);
    if (!parsed.success) continue;
    const step = parsed.data;
    if (step.source === "USER_EXPLICIT" || step.source === "USER_INPUT") {
      if (step.content !== undefined) {
        const text = antigravityUserText(step.content);
        if (text !== undefined) view.user(text);
      }
      continue;
    }
    if (step.source !== "MODEL") continue;
    for (const call of antigravityToolCalls(step.tool_calls))
      view.toolCall(call);
    if (step.content === undefined || step.content.trim().length === 0)
      continue;
    if (step.type === "PLANNER_RESPONSE") view.reply(step.content);
    else view.toolResult(step.content);
  }
  return view.build();
}

/** An Antigravity conversation id names its brain folder; the full transcript holds every step. */
export function findAntigravityTranscript(
  brainDir: string,
  sessionId: string,
): string | undefined {
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const candidate = join(
      brainDir,
      sessionId,
      ".system_generated",
      "logs",
      name,
    );
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function readTranscript(path: string, client: Client): TranscriptView {
  if (client === "codex") return readCodexTranscript(path);
  if (client === "muse") return readMuseTranscript(path);
  if (client === "antigravity") return readAntigravityTranscript(path);
  return readClaudeTranscript(path);
}

/** The user's standing request: the last few messages together, since an instruction is often followed by short corrections. */
export function recentRequests(messages: readonly string[], count = 6): string {
  return messages.slice(-count).join("\n---\n");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/u;

/**
 * A reply without its code: fenced blocks (``` or ~~~, to the matching
 * fence or the end) and indented blocks (lines indented four spaces or a
 * tab after a blank line, list items excepted) are dropped, prose kept.
 */
export function proseText(reply: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  let blank = true;
  let indented = false;
  for (const line of reply.split("\n")) {
    if (fence !== undefined) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
      if (
        close !== undefined &&
        close[0] === fence[0] &&
        close.length >= fence.length
      ) {
        fence = undefined;
        blank = true;
      }
      continue;
    }
    const open = FENCE.exec(line)?.[1];
    if (open !== undefined) {
      fence = open;
      continue;
    }
    if (line.trim() === "") {
      blank = true;
      kept.push(line);
      continue;
    }
    if (
      /^(?: {4}|\t)/u.test(line) &&
      (blank || indented) &&
      !LIST_ITEM.test(line)
    ) {
      indented = true;
      continue;
    }
    indented = false;
    blank = false;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * A reply's prose cut into sentences and list items so each claim is read
 * against the evidence on its own and a block can name the sentence. Code
 * blocks are left out (proseText); the split is on line breaks and
 * sentence-ending punctuation; empty fragments are dropped.
 */
export function replySentences(reply: string): string[] {
  return proseText(reply)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z`*(])/u)
    .map((sentence) => sentence.replace(/^[-*\d.\s#>|]+/u, "").trim())
    .filter((sentence) => /[A-Za-z0-9]/u.test(sentence));
}

/**
 * Evidence joined for a reading, cut at `limit` characters: the first
 * `leading` segments (a view's lead results, newest first) each clipped to
 * LEAD_LIMIT, then the other segments that mention a claimed path, then the
 * rest in their order (newest first in a view).
 */
export function joinEvidence(
  segments: readonly string[],
  claimedPaths: readonly string[] = [],
  limit = EVIDENCE_LIMIT,
  leading = LEAD_SEGMENTS,
): string {
  const leads = segments
    .slice(0, leading)
    .map((segment) => clipSegment(segment, LEAD_LIMIT, LEAD_TAIL));
  const others = segments.slice(leading);
  const names = (segment: string) =>
    claimedPaths.some((path) => segment.includes(path));
  const scoped =
    claimedPaths.length === 0
      ? others
      : [...others.filter(names), ...others.filter((s) => !names(s))];
  const parts: string[] = [];
  let length = 0;
  for (const part of [...leads, ...scoped]) {
    if (length >= limit) break;
    parts.push(part);
    length += part.length + 5;
  }
  const joined = parts.join("\n---\n");
  return joined.length > limit ? joined.slice(0, limit) : joined;
}
