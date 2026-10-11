// PreToolUse hook for the shell: refuses a delete through a variable path
// before the client's own confirmation prompt can stop the session. The agent
// gets the reason and rewrites the command. This matches a fixed shell syntax
// and makes no judgment call:
//
//   - the command line is split into simple commands at unquoted `;`, `;;`,
//     `&`, `&&`, `|`, `||`, newlines, parentheses (subshells, function
//     definitions `f() { ...; }` and `case` patterns `x)`) in one linear pass
//     over an explicit stack, not by recursion; backslash-newline
//     continuations are joined, `#` comments dropped, and the text of `$(...)`,
//     backtick and `<(...)`/`>(...)` substitutions is scanned as commands too;
//   - a here-document body is data: a quoted delimiter (`<<'EOF'`) makes its
//     body plain text, and an unquoted one only has its substitutions
//     scanned. A here-document whose delimiter line never comes is read as
//     commands;
//   - a simple command deletes when its command word (after `{`, `!`,
//     `then`/`do`/`else`, assignments, and the wrappers sudo, doas, env,
//     command, builtin, exec, coproc, nohup, setsid, nice, ionice, chrt,
//     taskset, stdbuf, busybox, time, timeout and xargs, with their options)
//     is rm, rmdir, unlink or shred, by name or path (`/bin/rm`, `\rm`);
//     `command -v rm` and `command -V rm` look a name up and run nothing;
//   - such a command is refused when an operand expands an unguarded
//     `$VAR`, `${VAR}` (any form but `${VAR:?...}`), `$0`…`$9`, `$@` or `$*`.
//     An operand of guarded `${VAR:?}` expansions is refused unless its
//     literal text names a path segment: alone (`"${DIR:?}"`), joined
//     (`"${A:?}${B:?}"`), followed by a bare `/` or `/./`, by a glob
//     (`"${DIR:?}"/*`) or holding a `..` segment (`"${DIR:?}/.."`) it is
//     refused; `"${DIR:?}/build"` and `/tmp/"${NAME:?}"` pass.
//
// Single-quoted and `$'...'` text and backslash-escaped `$` are data.
// `git rm`, `docker rm`, `npm rm` and the like are other commands. Past
// MAX_COMMAND_LENGTH characters or MAX_NESTING nested frames the command is
// not scanned; the hook lets it through with a note on stderr.

import type { Client } from "../transcript.js";
import {
  allow,
  deny,
  inputString,
  parsePayload,
  preToolPayloadSchema,
  translateAntigravityPreTool,
  type HookResult,
} from "./io.js";

/** Commands longer than this are not scanned (the guard fails open). */
export const MAX_COMMAND_LENGTH = 1_000_000;
/** Substitutions, subshells, quotes and here-documents nested deeper than this are not scanned (the guard fails open). */
export const MAX_NESTING = 64;

/** One shell word, with quoted-literal `$` and globs neutralized. */
interface Word {
  /** Expansions and globs that are live; single-quoted and escaped characters become `_`. */
  readonly live: string;
}

interface SimpleCommand {
  readonly words: readonly Word[];
  readonly text: string;
}

/** A level of command parsing: the top level, a substitution or a subshell. */
interface CommandFrame {
  readonly kind: "command";
  /** The character that closes it: `)` or a backtick; "" at the top level. */
  readonly close: ")" | "`" | "";
  /** Whether closing it leaves a substitution in the enclosing word. */
  readonly substitution: boolean;
  /** Where it opened, for the enclosing word's start. */
  readonly openedAt: number;
  /** Words of a here-document body: never a command. */
  readonly sink: boolean;
  words: Word[];
  live: string;
  inWord: boolean;
  wordStart: number;
  commandStart: number;
  commandEnd: number;
  /** Open `case` statements, and whether the next `)` ends a pattern. */
  caseLevel: number;
  casePattern: boolean;
}

/** Double-quoted text (or an unquoted here-document body) inside a word of `owner`. */
interface QuoteFrame {
  readonly kind: "quote";
  readonly owner: CommandFrame;
  /** Whether `"` ends it; a here-document body ends only at its end. */
  readonly closes: boolean;
}

type Frame = CommandFrame | QuoteFrame;

interface Heredoc {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
}

/** Why a command was not scanned. */
class ScanLimit extends Error {}

const DELETERS = new Set(["rm", "rmdir", "unlink", "shred"]);

/** Words that may stand before a command without being it. */
const RESERVED = new Set([
  "{",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
]);

/** Wrappers that run the command after their options, with the options that take a value. */
const WRAPPERS = new Map<string, ReadonlySet<string>>([
  [
    "sudo",
    new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]),
  ],
  ["doas", new Set(["-u", "-C"])],
  ["env", new Set(["-u", "-C", "-S"])],
  ["command", new Set()],
  ["builtin", new Set()],
  ["exec", new Set(["-a"])],
  ["coproc", new Set()],
  ["nohup", new Set()],
  ["setsid", new Set()],
  ["nice", new Set(["-n"])],
  ["ionice", new Set(["-c", "-n", "-p", "-P", "-u"])],
  ["chrt", new Set()],
  ["taskset", new Set()],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["busybox", new Set()],
  ["time", new Set(["-f", "-o"])],
  ["timeout", new Set(["-k", "-s"])],
  ["xargs", new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "-e"])],
]);

/** Wrappers whose first non-option word is an argument (a duration, priority or CPU mask). */
const LEADING_ARGUMENT = new Set(["timeout", "chrt", "taskset"]);

function commandFrame(
  close: CommandFrame["close"],
  substitution: boolean,
  openedAt: number,
  sink = false,
): CommandFrame {
  return {
    kind: "command",
    close,
    substitution,
    openedAt,
    sink,
    words: [],
    live: "",
    inWord: false,
    wordStart: 0,
    commandStart: -1,
    commandEnd: 0,
    caseLevel: 0,
    casePattern: false,
  };
}

/** Characters that end an unquoted here-document delimiter word. */
const DELIMITER_END = /[\s;&|<>()]/u;

/** The here-document delimiter word starting at `start`: its text without quotes, whether it was quoted, and where it ends. */
function heredocDelimiter(
  text: string,
  start: number,
): { delimiter: string; quoted: boolean; end: number } {
  let index = start;
  while (text[index] === " " || text[index] === "\t") index += 1;
  let delimiter = "";
  let quoted = false;
  while (index < text.length && !DELIMITER_END.test(text[index] ?? "")) {
    const char = text[index] ?? "";
    if (char === "'" || char === '"') {
      quoted = true;
      const end = text.indexOf(char, index + 1);
      const stop = end === -1 ? text.length : end;
      delimiter += text.slice(index + 1, stop);
      index = stop + 1;
    } else if (char === "\\") {
      quoted = true;
      delimiter += text[index + 1] ?? "";
      index += 2;
    } else {
      delimiter += char;
      index += 1;
    }
  }
  return { delimiter, quoted, end: index };
}

/**
 * Splits shell text into simple commands, quote-aware, in one pass.
 * Substitution bodies are scanned as commands of their own and stay in the
 * word that holds them. `depth` counts the here-document bodies this
 * text sits in; `heredoc` scans an unquoted body, where only substitutions run.
 */
function simpleCommands(
  text: string,
  depth: number,
  heredoc: boolean,
): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const root = commandFrame("", false, 0, heredoc);
  const stack: Frame[] = [root];
  if (heredoc) stack.push({ kind: "quote", owner: root, closes: false });
  const pending: Heredoc[] = [];
  /** Characters read looking for here-document delimiters; bounded so unterminated ones cannot make the scan quadratic. */
  let searched = 0;
  /** Delimiters known not to appear on any later line. */
  const absent = new Set<string>();

  const push = (frame: Frame) => {
    if (stack.length + depth >= MAX_NESTING)
      throw new ScanLimit(`it nests deeper than ${MAX_NESTING} levels`);
    stack.push(frame);
  };
  const begin = (frame: CommandFrame, at: number) => {
    if (!frame.inWord) {
      frame.inWord = true;
      frame.wordStart = at;
    }
  };
  const endCommand = (frame: CommandFrame) => {
    if (frame.words.length > 0 && !frame.sink)
      commands.push({
        words: frame.words,
        text: text.slice(frame.commandStart, frame.commandEnd),
      });
    frame.words = [];
    frame.commandStart = -1;
  };
  const endWord = (frame: CommandFrame, at: number) => {
    if (!frame.inWord) return;
    const live = frame.live;
    const first = frame.words.length === 0;
    frame.words.push({ live });
    if (frame.commandStart === -1) frame.commandStart = frame.wordStart;
    frame.commandEnd = at;
    frame.live = "";
    frame.inWord = false;
    if (first && live === "esac" && frame.caseLevel > 0) {
      frame.caseLevel -= 1;
      frame.casePattern = false;
    } else if (live === "in" && frame.words[0]?.live === "case") {
      endCommand(frame);
      frame.caseLevel += 1;
      frame.casePattern = true;
    }
  };
  /** Closes the substitution or subshell `frame` (the top command frame) at `at`, the index past its closing character. */
  const closeFrame = (frame: CommandFrame, at: number) => {
    endWord(frame, at - 1);
    endCommand(frame);
    stack.pop();
    if (!frame.substitution) return;
    const top = stack[stack.length - 1];
    const owner =
      top === undefined ? root : top.kind === "quote" ? top.owner : top;
    begin(owner, frame.openedAt);
    // The substitution's text stays in the word: a variable inside it feeds the operand.
    owner.live += text.slice(frame.openedAt, at);
  };
  /** Consumes a `${...}` from `start` (the `$`) and returns the index past it. */
  const braces = (owner: CommandFrame, start: number): number => {
    let level = 0;
    let index = start + 1;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\\") index += 1;
      else if (char === "{") level += 1;
      else if (char === "}") {
        level -= 1;
        if (level === 0) {
          index += 1;
          break;
        }
      }
    }
    begin(owner, start);
    owner.live += text.slice(start, index);
    return index;
  };
  /** Skips the bodies of the here-documents opened on the line that ends at `newline`; returns where scanning resumes. */
  const heredocBodies = (newline: number): number => {
    let position = newline + 1;
    for (const doc of pending.splice(0)) {
      const key = `${doc.stripTabs ? "-" : ""}${doc.delimiter}`;
      // A body whose delimiter never comes is read as commands.
      if (absent.has(key)) return newline + 1;
      let line = position;
      let found = -1;
      while (line <= text.length) {
        const end = text.indexOf("\n", line);
        const stop = end === -1 ? text.length : end;
        const content = text.slice(line, stop);
        searched += stop - line + 1;
        if (searched > 2 * MAX_COMMAND_LENGTH)
          throw new ScanLimit("its here-documents never end");
        if (
          (doc.stripTabs ? content.replace(/^\t+/u, "") : content) ===
          doc.delimiter
        ) {
          found = line;
          position = end === -1 ? text.length : end + 1;
          break;
        }
        if (end === -1) break;
        line = end + 1;
      }
      if (found === -1) {
        absent.add(key);
        return newline + 1;
      }
      if (!doc.quoted)
        commands.push(
          ...simpleCommands(
            text.slice(newline + 1, found),
            depth + stack.length,
            true,
          ),
        );
      newline = position - 1;
    }
    return position;
  };

  let index = 0;
  while (index < text.length) {
    const top = stack[stack.length - 1] ?? root;
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (top.kind === "quote") {
      const owner = top.owner;
      if (char === '"' && top.closes) {
        stack.pop();
        index += 1;
      } else if (char === "\\") {
        owner.live += next === "$" || next === "`" ? "_" : next;
        index += 2;
      } else if (char === "$" && next === "(") {
        push(commandFrame(")", true, index));
        index += 2;
      } else if (char === "`") {
        if (owner.close === "`") {
          // A backtick inside double quotes inside a backtick substitution ends it.
          while (stack[stack.length - 1] !== owner) stack.pop();
          closeFrame(owner, index + 1);
        } else push(commandFrame("`", true, index));
        index += 1;
      } else if (char === "$" && next === "{") {
        index = braces(owner, index);
      } else {
        // Globs inside double quotes are literal.
        owner.live += char === "*" || char === "?" || char === "[" ? "_" : char;
        index += 1;
      }
      continue;
    }

    const frame = top;
    if (char === "\\") {
      if (next === "\n") {
        index += 2;
        continue;
      }
      begin(frame, index);
      frame.live += next === "$" || next === "`" || next === "*" ? "_" : next;
      index += 2;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord(frame, index);
      index += 1;
      continue;
    }
    if (char === "\n") {
      endWord(frame, index);
      endCommand(frame);
      index = pending.length === 0 ? index + 1 : heredocBodies(index);
      continue;
    }
    if (char === ";") {
      endWord(frame, index);
      endCommand(frame);
      index += 1;
      // `;;`, `;&` and `;;&` end a case arm: a pattern comes next.
      if (frame.caseLevel > 0 && (next === ";" || next === "&")) {
        frame.casePattern = true;
        index += 1;
        if (text[index] === "&") index += 1;
      }
      continue;
    }
    if (char === "&" || char === "|") {
      endWord(frame, index);
      endCommand(frame);
      index += 1;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      begin(frame, index);
      push(commandFrame(")", true, index));
      index += 2;
      continue;
    }
    if (char === "<" && next === "<" && text[index + 2] === "<") {
      // A here-string: its word is an operand like any other.
      begin(frame, index);
      frame.live += "<<<";
      index += 3;
      continue;
    }
    if (char === "<" && next === "<") {
      endWord(frame, index);
      const stripTabs = text[index + 2] === "-";
      const word = heredocDelimiter(text, index + (stripTabs ? 3 : 2));
      if (word.delimiter.length > 0)
        pending.push({
          delimiter: word.delimiter,
          quoted: word.quoted,
          stripTabs,
        });
      index = word.end;
      continue;
    }
    if (char === "(") {
      endWord(frame, index);
      index += 1;
      // `(pattern)` opens a case pattern, not a subshell.
      if (frame.casePattern) continue;
      endCommand(frame);
      push(commandFrame(")", false, index - 1));
      continue;
    }
    if (char === ")") {
      if (frame.casePattern) {
        endWord(frame, index);
        endCommand(frame);
        frame.casePattern = false;
      } else if (frame.close === ")") closeFrame(frame, index + 1);
      else {
        endWord(frame, index);
        endCommand(frame);
      }
      index += 1;
      continue;
    }
    if (char === "#" && !frame.inWord) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "`") {
      if (frame.close === "`") closeFrame(frame, index + 1);
      else {
        begin(frame, index);
        push(commandFrame("`", true, index));
      }
      index += 1;
      continue;
    }
    begin(frame, index);
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      const stop = end === -1 ? text.length : end + 1;
      frame.live += text
        .slice(index + 1, end === -1 ? text.length : end)
        .replace(/[$`*?[]/gu, "_");
      index = stop;
      continue;
    }
    if (char === "$" && next === "'") {
      // ANSI-C quoting: literal text with backslash escapes.
      let end = index + 2;
      while (end < text.length && text[end] !== "'")
        end += text[end] === "\\" ? 2 : 1;
      frame.live += "_".repeat(Math.max(1, end - index - 2));
      index = end + 1;
      continue;
    }
    if (char === '"') {
      push({ kind: "quote", owner: frame, closes: true });
      index += 1;
      continue;
    }
    if (char === "$" && next === "(") {
      push(commandFrame(")", true, index));
      index += 2;
      continue;
    }
    if (char === "$" && next === "{") {
      index = braces(frame, index);
      continue;
    }
    frame.live += char;
    index += 1;
  }
  for (let level = stack.length - 1; level >= 0; level -= 1) {
    const frame = stack[level];
    if (frame?.kind !== "command") continue;
    endWord(frame, text.length);
    endCommand(frame);
  }
  return commands;
}

/** The index of the command word, past reserved words, assignments and wrappers with their options; -1 when the line runs no command (`command -v`). */
function commandWordIndex(words: readonly Word[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index]?.live ?? "";
    if (RESERVED.has(word) || /^[A-Za-z_]\w*=/u.test(word)) {
      index += 1;
      continue;
    }
    const valued = WRAPPERS.get(word);
    if (valued === undefined) return index;
    index += 1;
    // `coproc NAME { ...; }` names the coprocess before its command.
    if (word === "coproc" && words[index + 1]?.live === "{") index += 1;
    let leading = LEADING_ARGUMENT.has(word);
    while (index < words.length) {
      const option = words[index]?.live ?? "";
      if (option === "--") {
        index += 1;
        break;
      }
      if (word === "command" && (option === "-v" || option === "-V")) return -1;
      if (/^[A-Za-z_]\w*=/u.test(option) && word === "env") {
        index += 1;
        continue;
      }
      if (option.startsWith("-") && option.length > 1) {
        index += valued.has(option) ? 2 : 1;
        continue;
      }
      if (leading) {
        leading = false;
        index += 1;
        continue;
      }
      break;
    }
  }
  return index;
}

/** Output redirections and their targets are not operands. */
function operands(words: readonly Word[]): Word[] {
  const kept: Word[] = [];
  let skipNext = false;
  for (const word of words) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (/^(?:\d*>{1,2}|&>{1,2}|>&|\d*>&)$/u.test(word.live)) {
      skipNext = true;
      continue;
    }
    if (/^(?:\d*>{1,2}|&>{1,2}|\d*>&)./u.test(word.live)) continue;
    kept.push(word);
  }
  return kept;
}

const EXPANSION = /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@*])/gu;
const GUARDED = /^\$\{(?:[A-Za-z_]\w*|[0-9]):\?[^}]*\}$/u;

/** Whether an operand's live text deletes through a variable it does not guard. */
function unsafeOperand(live: string): boolean {
  const expansions = [...live.matchAll(EXPANSION)];
  if (expansions.length === 0) return false;
  if (expansions.some((match) => !GUARDED.test(match[0]))) return true;
  // Guarded variables must sit inside a literal path that names something:
  // alone or joined they name a whole tree, a bare `/` or `/./` after them
  // too, a glob after them is refused, and so is any `..` segment.
  const first = expansions[0]?.index ?? 0;
  const after = live.slice(first).replace(EXPANSION, "").replace(/"/gu, "");
  if (/[*?[]/u.test(after)) return true;
  const segments = live.replace(EXPANSION, "/").replace(/"/gu, "").split("/");
  if (segments.includes("..")) return true;
  return !segments.some((segment) => segment !== "" && segment !== ".");
}

/** The scan of one command line: the first simple command that deletes through an unguarded variable, or why the line was not scanned. */
export function scanDeletes(command: string): {
  readonly offending?: string;
  readonly skipped?: string;
} {
  if (command.length > MAX_COMMAND_LENGTH)
    return {
      skipped: `it is longer than ${MAX_COMMAND_LENGTH} characters`,
    };
  let commands: SimpleCommand[];
  try {
    commands = simpleCommands(command, 0, false);
  } catch (error) {
    if (error instanceof ScanLimit) return { skipped: error.message };
    throw error;
  }
  for (const simple of commands) {
    const at = commandWordIndex(simple.words);
    const word = simple.words[at];
    if (word === undefined || word.live.includes("$")) continue;
    const name = word.live.slice(word.live.lastIndexOf("/") + 1);
    if (!DELETERS.has(name)) continue;
    if (
      operands(simple.words.slice(at + 1)).some((operand) =>
        unsafeOperand(operand.live),
      )
    )
      return { offending: simple.text };
  }
  return {};
}

/** The first simple command that deletes through an unguarded variable, if any. */
export function unguardedDelete(command: string): string | undefined {
  return scanDeletes(command).offending;
}

export function bashGuard(stdin: string, client: Client): HookResult {
  const payload =
    client === "antigravity"
      ? translateAntigravityPreTool(stdin)
      : parsePayload(preToolPayloadSchema, stdin);
  if (typeof payload === "string") return allow(client, "PreToolUse");
  const command = inputString(payload.tool_input, "command", "cmd") ?? "";
  const scan = scanDeletes(command);
  if (scan.skipped !== undefined)
    return {
      ...allow(client, "PreToolUse"),
      stderr: `vibecheck-linear-jev: the delete guard did not scan this command because ${scan.skipped}; it runs unchecked.\n`,
    };
  if (scan.offending === undefined) return allow(client, "PreToolUse");
  return deny(
    client,
    `Refused a delete through a variable path (${scan.offending.trim().slice(0, 160)}). Rewrite it with literal absolute paths, or guard each variable as "\${VAR:?}" inside a literal path such as "\${VAR:?}/build" so an empty value fails. Never delete through an unguarded variable.`,
  );
}
