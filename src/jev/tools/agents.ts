// watch-agents --project ID [--session SESSION-ID] [--client claude|codex|muse|antigravity]
// watch-agents --transcript FILE [--transcript FILE...] [--client claude|codex|muse|antigravity]
//   Reads what running agents wrote since the last look and flags a message
//   that abandons an item with work left (gives-up). The agents are the
//   descendant sessions of SESSION-ID in the ledger (the coordinator when
//   omitted); each one's transcript is found by its client session id. The
//   last line read per transcript is the newest line a recorded verdict
//   names, so nothing outside the ledger keeps state. Exit 2 when flagged.
//
// report-of AGENT-OR-SESSION-ID [DIRECTORY]
//   Prints an agent's final report: the text of its last reply.
//
// exception-check FILE...
//   Whether each file holds data or text only: counts control-flow lines
//   outside comments and strings. Exit 2 when a file holds logic.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { antigravityBrainDir, museSessionsDir } from "../../paths.js";
import { OPEN_WORK, projectKeyOf } from "../../ledger/access.js";
import type { SessionRow } from "../../local/types.js";
import {
  appendEntry,
  queryEntries,
  type Subject,
} from "../../verification/store.js";
import { givesUpBattery } from "../batteries.js";
import { checkDataOnly } from "../code.js";
import { entryFor } from "../entries.js";
import { runCheck } from "../judgment.js";
import { settleMany } from "../lib/index.js";
import type { Client } from "../transcript.js";
import {
  fixed,
  judgmentOf,
  parse,
  projectOf,
  UsageError,
  withStore,
  type ToolIO,
} from "./common.js";

const MAX_DEPTH = 6;

/** Whether one of the directory's ancestor folders carries the id: an Antigravity conversation names its brain folder three levels above its transcripts. */
function ancestorIs(directory: string, id: string, levels: number): boolean {
  let current = directory;
  for (let level = 0; level < levels; level += 1) {
    if (basename(current) === id) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/** Transcript files for a session or agent id, under the clients' session folders. Muse names the folder, not the file. */
export function findTranscripts(
  id: string,
  roots: readonly string[],
): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(directory, name);
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) walk(path, depth + 1);
      else if (
        name.endsWith(".jsonl") &&
        (name === `${id}.jsonl` ||
          name === `agent-${id}.jsonl` ||
          name.endsWith(`-${id}.jsonl`) ||
          (name === "session.jsonl" && basename(directory) === id) ||
          ((name === "transcript.jsonl" || name === "transcript_full.jsonl") &&
            ancestorIs(directory, id, 4)))
      )
        found.push(path);
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
}

function defaultRoots(io: ToolIO): string[] {
  const home = io.env["HOME"] ?? homedir();
  return [
    join(io.env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude"), "projects"),
    join(io.env["CODEX_HOME"] ?? join(home, ".codex"), "sessions"),
    museSessionsDir(io.env),
    antigravityBrainDir(io.env),
  ];
}

const lineSchema = z.looseObject({
  type: z.string(),
  message: z.looseObject({ content: z.unknown() }).optional(),
  payload: z
    .looseObject({
      type: z.string().optional(),
      role: z.string().optional(),
      content: z.unknown(),
    })
    .optional(),
});
const textPartsSchema = z.array(
  z.looseObject({ type: z.string().optional(), text: z.string().optional() }),
);
const museReplySchema = z.looseObject({
  payload: z.looseObject({
    event: z.looseObject({
      kind: z.string(),
      text: z.string().optional(),
    }),
  }),
});
const antigravityReplySchema = z.looseObject({
  source: z.string().optional(),
  type: z.string().optional(),
  content: z.string().optional(),
});

/** The agent's reply texts with their line numbers, from any client's transcript. */
export function replyTexts(path: string): { line: number; text: string }[] {
  const texts: { line: number; text: string }[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((raw, index) => {
      if (raw.length === 0) return;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return;
      }
      const muse = museReplySchema.safeParse(value);
      if (
        muse.success &&
        muse.data.payload.event.kind === "assistant_message_committed" &&
        muse.data.payload.event.text !== undefined
      ) {
        const text = muse.data.payload.event.text.trim();
        if (text.length > 0) texts.push({ line: index + 1, text });
        return;
      }
      const antigravity = antigravityReplySchema.safeParse(value);
      if (
        antigravity.success &&
        antigravity.data.source === "MODEL" &&
        antigravity.data.type === "PLANNER_RESPONSE" &&
        antigravity.data.content !== undefined
      ) {
        const text = antigravity.data.content.trim();
        if (text.length > 0) texts.push({ line: index + 1, text });
        return;
      }
      const line = lineSchema.safeParse(value);
      if (!line.success) return;
      const content =
        line.data.type === "assistant"
          ? line.data.message?.content
          : line.data.type === "response_item" &&
              line.data.payload?.type === "message" &&
              line.data.payload.role === "assistant"
            ? line.data.payload.content
            : undefined;
      const parts = textPartsSchema.safeParse(content);
      if (!parts.success) return;
      const text = parts.data
        .filter((part) => part.type === "text" || part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (text.length > 0) texts.push({ line: index + 1, text });
    });
  return texts;
}

/** A usage limit or API failure is the client speaking, not the agent deciding anything. */
function clientNotice(text: string): boolean {
  return /^(You've hit your (session|usage) limit|API Error)/u.test(text);
}

export async function watchAgentsCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const { values } = parse(args, {
    project: { type: "string" },
    session: { type: "string" },
    transcript: { type: "string", multiple: true },
    client: { type: "string" },
  });
  const projectId = projectOf(values.project);
  const watched: { path: string; subject: Subject }[] = [];
  for (const path of values.transcript ?? [])
    watched.push({ path, subject: { projectId: projectId ?? null } });
  if (projectId !== undefined) {
    const found = await withStore(io, (store) => {
      const project = store.project(projectKeyOf(projectId));
      if (project === undefined)
        throw new UsageError(`no project ${projectId} on this machine`);
      const sessions = store.sessions(project.key);
      const root = values.session ?? project.coordinatorSessionId;
      const descendants: SessionRow[] = [];
      const pending = [root];
      while (pending.length > 0) {
        const parent = pending.pop();
        for (const session of sessions)
          if (session.parentSessionId === parent) {
            descendants.push(session);
            pending.push(session.id);
          }
      }
      const keys = new Map(
        (project.planRevision === 0
          ? []
          : (store.revision(project.key, project.planRevision)?.tasks ?? [])
        ).map((task) => [task.issueId, task.key]),
      );
      return descendants.map((session) => ({
        session,
        open: store
          .workForSession(session.id)
          .filter((record) => OPEN_WORK.has(record.status))
          .map((record) => ({
            id: record.id,
            key: keys.get(record.issueId) ?? record.identifier,
          })),
      }));
    });
    for (const { session, open } of found)
      for (const path of findTranscripts(
        session.externalSessionId,
        defaultRoots(io),
      ))
        watched.push({
          path,
          subject: {
            projectId,
            sessionId: session.id,
            ...(open.length === 1 && open[0] !== undefined
              ? { workId: open[0].id, taskId: open[0].key }
              : {}),
          },
        });
  }
  if (watched.length === 0)
    throw new UsageError(
      "usage: watch-agents --project ID [--session ID] | --transcript FILE...",
    );
  const seen = await withStore(io, (store) =>
    queryEntries(store.verificationAccess(), {
      source: "watch:agents",
      kinds: ["verdict", "unavailable"],
      limit: 1_000_000,
    }),
  );
  const lastLine = new Map<string, number>();
  for (const entry of seen) {
    if (entry.kind !== "verdict" && entry.kind !== "unavailable") continue;
    const evidence = entry.body.evidence;
    if (evidence?.line === undefined) continue;
    lastLine.set(
      evidence.ref,
      Math.max(lastLine.get(evidence.ref) ?? 0, evidence.line),
    );
  }
  const passages: {
    path: string;
    line: number;
    message: string;
    previous?: string;
    subject: Subject;
  }[] = [];
  for (const { path, subject } of watched) {
    let previous: string | undefined;
    for (const { line, text } of replyTexts(path)) {
      if (line > (lastLine.get(path) ?? 0) && !clientNotice(text))
        passages.push({
          path,
          line,
          message: text,
          ...(previous === undefined ? {} : { previous }),
          subject,
        });
      previous = text;
    }
  }
  const judgment = judgmentOf(io);
  const runs = await settleMany(
    passages,
    (passage) =>
      runCheck(judgment, givesUpBattery, {
        message: passage.message,
        ...(passage.previous === undefined
          ? {}
          : { previous: passage.previous }),
      }),
    16,
  );
  let flagged = 0;
  await withStore(io, (store) => {
    const access = store.verificationAccess();
    store.transaction(() =>
      runs.forEach((settled, index) => {
        const passage = passages[index];
        if (passage === undefined || !settled.ok) return;
        const input = {
          message: passage.message,
          ...(passage.previous === undefined
            ? {}
            : { previous: passage.previous }),
        };
        const entry = entryFor(givesUpBattery, input, settled.value, {
          source: "watch:agents",
          gate: false,
          evidence: {
            kind: "transcript",
            ref: passage.path,
            line: passage.line,
          },
          reason: (decision) => `gives up ${fixed(decision.givesUp)}`,
        });
        if (entry !== undefined) appendEntry(access, passage.subject, entry);
        if (
          settled.value.kind === "verdict" &&
          settled.value.run.decision.block
        ) {
          flagged += 1;
          io.out(
            `GIVES-UP ${fixed(settled.value.run.decision.givesUp)} [${passage.path}:${passage.line}] ${passage.message.slice(0, 220).replace(/\n/gu, " ")}`,
          );
        }
      }),
    );
  });
  io.out(
    `watch: ${passages.length} new messages from ${watched.length} transcripts, ${flagged} flagged`,
  );
  return flagged > 0 ? 2 : 0;
}

export async function reportOfCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const { positionals } = parse(args, {});
  const [id, directory] = positionals;
  if (id === undefined)
    throw new UsageError("usage: report-of AGENT-OR-SESSION-ID [DIRECTORY]");
  const files = findTranscripts(
    id,
    directory === undefined ? defaultRoots(io) : [directory],
  );
  const file = files[0];
  if (file === undefined) throw new UsageError(`no transcript found for ${id}`);
  const last = replyTexts(file).at(-1);
  if (last === undefined) throw new UsageError(`${file} has no reply text`);
  io.out(last.text);
  return 0;
}

export async function exceptionCheckCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const { positionals } = parse(args, {});
  if (positionals.length === 0)
    throw new UsageError("usage: exception-check FILE...");
  let mixed = 0;
  for (const file of positionals) {
    const result = checkDataOnly(file, readFileSync(file, "utf8"));
    if (!result.dataOnly) mixed += 1;
    io.out(
      `${(result.dataOnly ? "data" : "MIXED").padEnd(5)} control ${String(result.controlLines).padStart(3)} / ${String(result.lines).padStart(4)} lines  ${result.battery ? "battery" : "text   "}  ${file}`,
    );
  }
  return mixed > 0 ? 2 : 0;
}

export type { Client };
