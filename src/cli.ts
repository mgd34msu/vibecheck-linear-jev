#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { configCommand, ensureConfig } from "./jev/config-file.js";
import {
  ConfigError,
  DEFAULT_HOOK_SECONDS,
  DEFAULT_SOURCES,
  loadConfig,
  sourcesOf,
  type Config,
  type SourceConfig,
} from "./jev/config.js";
import { bashGuard } from "./jev/hooks/bash-guard.js";
import {
  allow,
  failOpen,
  type HookDeps,
  type HookEvent,
  type HookResult,
} from "./jev/hooks/io.js";
import { preToolHook } from "./jev/hooks/pretool.js";
import { sessionEndHook, stopHook } from "./jev/hooks/stop.js";
import { isJudgment, openJudgment } from "./jev/judgment.js";
import { layaCommand } from "./jev/laya.js";
import {
  exceptionCheckCommand,
  reportOfCommand,
  watchAgentsCommand,
} from "./jev/tools/agents.js";
import { checkCommand } from "./jev/tools/check.js";
import { UsageError, type ToolIO } from "./jev/tools/common.js";
import { labelCommand } from "./jev/tools/label.js";
import { fixturesCommand, measureCommand } from "./jev/tools/measure.js";
import { sourcesCommand } from "./jev/tools/sources.js";
import type { Client } from "./jev/transcript.js";
import {
  antigravityBrainDir,
  configFile,
  defaultDatabase,
  expandHome,
  museSessionsDir,
  type Environment,
} from "./paths.js";
import { identifierSchema } from "./schemas.js";
import { createHttpApp, createServer } from "./server.js";
import { loadKey } from "./keys.js";
import { Board } from "./ledger/board.js";
import { resolveTeam, workspaceFor } from "./ledger/context.js";
import { reconcile } from "./ledger/reconcile.js";
import { BoardError } from "./errors.js";
import type { LinearApi } from "./linear/api.js";
import { isLinearError } from "./linear/errors.js";
import { DEFAULT_KEY_ENV, openLinear } from "./linear/open.js";
import { SqliteLocalStore } from "./local/store.js";
import { LedgerVerifier } from "./verification/ledger.js";
import { version } from "./version.js";

export class CliUsageError extends Error {
  constructor(
    message: string,
    /** The subcommand whose usage applies; the server options when unset. */
    readonly command?: string,
  ) {
    super(message);
  }
}

export { defaultDatabase };

const configurationSchema = z
  .object({
    transport: z.enum(["stdio", "streamable-http"]),
    database: z.string(),
    host: z
      .string()
      .min(1)
      .regex(/^[^\s/]+$/u, "--host must be a hostname or IP address"),
    port: z
      .string()
      .regex(/^[+-]?\d+$/, "--port must be an integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535)),
    allowedHosts: z.array(
      z
        .string()
        .min(1)
        .regex(
          /^[^\s/]+$/u,
          "--allowed-host must be a Host value, optionally with a port",
        ),
    ),
    token: z.string(),
  })
  .superRefine((config, context) => {
    if (
      config.transport === "streamable-http" &&
      (!config.token || /\s/u.test(config.token))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "HTTP requires VIBECHECK_LINEAR_JEV_TOKEN with a nonempty token containing no whitespace",
      });
    }
  });
export type CliOptions = z.infer<typeof configurationSchema> & {
  projects: ReadonlySet<string> | undefined;
};

export function parseArgs(
  arguments_: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  config: Config = {},
): CliOptions {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: {
        transport: { type: "string", default: "stdio" },
        database: {
          type: "string",
          default: defaultDatabase(environment, config.data ?? {}),
        },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "8765" },
        "allowed-host": { type: "string", multiple: true, default: [] },
      },
    }));
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : "Invalid arguments.",
    );
  }
  const parsed = configurationSchema.safeParse({
    ...values,
    allowedHosts: values["allowed-host"],
    token: environment.VIBECHECK_LINEAR_JEV_TOKEN ?? "",
  });
  if (!parsed.success)
    throw new CliUsageError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  let projects: ReadonlySet<string> | undefined;
  if (environment.VIBECHECK_LINEAR_JEV_PROJECTS !== undefined) {
    const identifiers = z
      .array(identifierSchema)
      .safeParse(
        environment.VIBECHECK_LINEAR_JEV_PROJECTS.split(",").map((value) =>
          value.trim(),
        ),
      );
    if (!identifiers.success)
      throw new CliUsageError(
        "VIBECHECK_LINEAR_JEV_PROJECTS must be a comma-separated list of nonempty project IDs",
      );
    projects = new Set(identifiers.data);
  }
  return {
    ...parsed.data,
    database: expandHome(parsed.data.database),
    projects,
  };
}

const help = `vibecheck-linear-jev: a work ledger for coding agents on Linear whose reports are checked.

Usage: vibecheck-linear-jev [options]            run the MCP ledger server
  --transport stdio|streamable-http   Default: stdio
  --database PATH                    local store path (state.sqlite3)
  --host HOST                        Default: 127.0.0.1
  --port PORT                        Default: 8765
  --allowed-host HOST[:PORT]          Additional allowed Host; repeat as needed
  --version                          Print version
  --help                             Print this help

Commands:
  hook pretool|bash-guard|stop|session-end --client claude|codex|muse|antigravity   run a hook (reads stdin)
  measure fixtures [--runs N] [--source ID] [--battery ID]
  measure live [--project ID]
  measure replay [CHECK-ID] [--project ID] [--source ID]
  fixtures [--source ID] [--battery ID]
  label list|mark|mark-where|mark-last ...
  check brief|message|report|diff ...
  watch-agents --project ID [--session ID] | --transcript FILE...
  exception-check FILE...
  report-of AGENT-OR-SESSION-ID [DIRECTORY]
  sources [--source ID]                 probe each judgment source
  laya install | laya serve [--source ID] [--port N]
  config path | config init [--force] | config check
  linear doctor                         check the key, team, workflow states and rate-limit headroom
  sync [--project ID]                   send queued Linear writes and reconcile projects

Linear: the key comes from LINEAR_API_KEY (or linear.apiKeyEnv), linear.apiKeyFile,
or your interactive shell. HTTP requires VIBECHECK_LINEAR_JEV_TOKEN.
VIBECHECK_LINEAR_JEV_DB sets the local store path.
VIBECHECK_LINEAR_JEV_PROJECTS restricts access to comma-separated project IDs.
VIBECHECK_LINEAR_JEV_CONFIG sets the config file path.

Exit codes: 0 success; 1 failure, a usage error, or a check that could not
run (no usable source, unreadable input); 2 only when check flagged its input.
`;

function toolIO(environment: Environment, config?: Config): ToolIO {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    env: environment,
    ...(config === undefined ? {} : { config }),
  };
}

/** Ends the process once stdout and stderr have flushed. */
async function exitAfterFlush(): Promise<void> {
  await new Promise<void>((resolve) =>
    process.stdout.write("", () => resolve()),
  );
  await new Promise<void>((resolve) =>
    process.stderr.write("", () => resolve()),
  );
  process.exit(process.exitCode ?? 0);
}

const HOOKS = new Set(["pretool", "bash-guard", "stop", "session-end"]);

/** Runs one hook over its stdin. A bad config or an overrun deadline fails open. */
export async function runHook(
  name: string,
  client: Client,
  stdin: string,
  environment: Environment,
): Promise<HookResult> {
  const event: HookEvent =
    name === "stop"
      ? client === "muse"
        ? "SubagentStop"
        : "Stop"
      : name === "session-end"
        ? "SessionEnd"
        : "PreToolUse";
  let config: Config;
  try {
    config = loadConfig(environment);
  } catch (error) {
    return failOpen(
      client,
      event,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (name === "bash-guard")
    return config.hooks?.bashGuard === false
      ? allow(client, event)
      : bashGuard(stdin, client);
  if (
    (name === "pretool" && config.hooks?.briefCheck === false) ||
    ((name === "stop" || name === "session-end") &&
      config.hooks?.stop === false)
  )
    return allow(client, event);
  const seconds =
    name === "stop" || name === "session-end"
      ? (config.hooks?.stopSeconds ?? DEFAULT_HOOK_SECONDS.stop)
      : (config.hooks?.briefCheckSeconds ?? DEFAULT_HOOK_SECONDS.briefCheck);
  const deps: HookDeps = {
    client,
    databasePath: defaultDatabase(environment, config.data ?? {}),
    antigravityBrain: antigravityBrainDir(environment),
    sessionsDir: museSessionsDir(environment),
    judgment: () => openJudgment(config, { environment, autostart: true }),
    // The Stop hook's own budget: no reading starts after three quarters of
    // the configured time, and it answers by the configured time.
    stopBudget: { startMs: seconds * 750, totalMs: seconds * 1000 },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<HookResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          failOpen(
            client,
            event,
            `the readings took longer than ${seconds} seconds; the work goes ahead unchecked`,
          ),
        ),
      seconds * 1000,
    );
  });
  try {
    const work =
      name === "stop"
        ? stopHook(stdin, deps)
        : name === "session-end"
          ? sessionEndHook(stdin, deps)
          : preToolHook(stdin, deps);
    return await Promise.race([work, deadline]);
  } catch (error) {
    return failOpen(
      client,
      event,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Codex payloads carry `turn_id`; Claude Code's do not. Muse payloads carry
 * it too, so an explicit Muse flag wins and the payload only separates Codex
 * from Claude Code. Antigravity payloads carry `toolCall` with a
 * `conversationId`, which no other client sends.
 */
export function detectClient(stdin: string, flag: Client): Client {
  if (flag === "muse") return "muse";
  if (flag === "antigravity") return "antigravity";
  try {
    const value: unknown = JSON.parse(stdin);
    if (typeof value === "object" && value !== null) {
      if ("turn_id" in value) return "codex";
      if ("toolCall" in value && "conversationId" in value)
        return "antigravity";
    }
  } catch {
    return flag;
  }
  return flag;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Builds the board for a process: local store, Linear client, checks. The
 * Linear client is opened on first use, so a server starts without waiting
 * on the key lookup and a missing key fails only the calls that need Linear.
 */
export function openBoard(
  databasePath: string,
  config: Config,
  environment: Environment,
  verifier: LedgerVerifier | undefined,
): Board {
  let api: LinearApi | undefined;
  let missing: string | undefined;
  const linear = (): LinearApi => {
    if (api !== undefined) return api;
    if (missing === undefined) {
      let opened: ReturnType<typeof openLinear>;
      try {
        opened = openLinear(config.linear, environment);
      } catch (error) {
        throw new BoardError(
          "unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (opened.api !== undefined) {
        api = opened.api;
        return api;
      }
      missing = opened.reason;
    }
    throw new BoardError(
      "unavailable",
      `Linear is not available: ${missing}. Set LINEAR_API_KEY or linear.apiKeyFile.`,
    );
  };
  return new Board({
    store: new SqliteLocalStore(databasePath),
    linear,
    ...(verifier === undefined ? {} : { verifier }),
    checksOff: config.ledger?.verify === false,
    ...(config.linear === undefined ? {} : { config: config.linear }),
  });
}

/** `linear doctor`: the key, the team, the workflow states and rate-limit headroom. */
export async function linearDoctor(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const config = loadConfig(io.env);
  const opened = openLinear(config.linear, io.env);
  if (opened.api === undefined) {
    io.out(`key: missing (${opened.reason})`);
    return 1;
  }
  const api = opened.api;
  io.out(`key: found (${opened.from})`);
  try {
    const viewer = await api.viewer();
    io.out(`auth: ok, ${viewer.name} in ${viewer.organization.name}`);
    const team = await resolveTeam(api, config.linear?.team ?? args[0]);
    io.out(`team: ${team.key} (${team.name})`);
    const store = new SqliteLocalStore(
      defaultDatabase(io.env, config.data ?? {}),
    );
    try {
      const board = new Board({
        store,
        linear: api,
        ...(config.linear === undefined ? {} : { config: config.linear }),
      });
      const { resolved, all } = await workspaceFor(
        board.deps,
        team.id,
      ).states();
      io.out(
        `states: in progress "${resolved.inProgress.name}", review ${resolved.review === null ? "none (label vc:awaiting-integration)" : `"${resolved.review.name}"`}, done "${resolved.done.name}", canceled "${resolved.canceled.name}" (${all.length} states)`,
      );
    } finally {
      store.close();
    }
    const limit = api.rateLimit();
    io.out(
      limit === null
        ? "rate limit: no headroom reported"
        : `rate limit: ${limit.requestsRemaining}/${limit.requestsLimit} requests, ${limit.complexityRemaining}/${limit.complexityLimit} complexity left; resets ${new Date(limit.resetAt).toISOString()}`,
    );
    return 0;
  } catch (error) {
    io.out(
      `failed: ${isLinearError(error) ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/** `sync`: drains the outbox and reconciles every project (or one) with Linear. */
export async function syncCommand(args: string[], io: ToolIO): Promise<number> {
  const { values } = strictArgs("sync", () =>
    parseNodeArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: { project: { type: "string" } },
    }),
  );
  const config = loadConfig(io.env);
  // sync exists to talk to Linear: without a key it fails up front, naming
  // where the key is looked up, instead of draining nothing and exiting 0.
  const opened = openLinear(config.linear, io.env);
  if (opened.api === undefined) {
    io.err(
      `sync: Linear is not available: ${opened.reason}. The key is read from ${config.linear?.apiKeyEnv ?? DEFAULT_KEY_ENV} (linear.apiKeyEnv), then the file named by linear.apiKeyFile in ${configFile(io.env)}, then your interactive shell's environment.`,
    );
    return 1;
  }
  const verifier = openVerifier(config, io.env);
  const board = new Board({
    store: new SqliteLocalStore(defaultDatabase(io.env, config.data ?? {})),
    linear: opened.api,
    ...(verifier === undefined ? {} : { verifier }),
    ...(config.linear === undefined ? {} : { config: config.linear }),
  });
  try {
    const drained = await board.drain();
    io.out(
      `outbox: ${drained.sent} sent, ${drained.pending} waiting${drained.stopped === undefined ? "" : ` (stopped: ${drained.stopped})`}; completions: ${drained.completions.resumed} finished, ${drained.completions.pending} pending`,
    );
    const projects = board.deps.store
      .allProjects()
      .filter(
        (project) =>
          values.project === undefined || project.key === values.project,
      );
    if (values.project !== undefined && projects.length === 0) {
      io.err(`no project ${values.project} on this machine`);
      return 1;
    }
    let failed = false;
    for (const project of projects) {
      if (project.linearProjectId === "" || project.adoption === "pending")
        continue;
      try {
        const result = await reconcile(board.deps, project);
        io.out(
          `${project.key}: ${result.changed} issues changed, ${result.rechecked} re-checked, ${result.waiting} re-checks waiting${result.queued === 0 ? "" : `, ${result.queued} writes queued`}`,
        );
      } catch (error) {
        failed = true;
        io.out(
          `${project.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return failed ? 1 : 0;
  } finally {
    board.close();
  }
}

/** Runs an argument parser; a bad option or argument is a usage error naming the command. */
function strictArgs<T>(command: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error),
      command,
    );
  }
}

/**
 * Subcommands that take no options and whose own code reads every argument
 * as a positional: an option given to them is refused as a usage error
 * here, as every other command's parser refuses it. Words after `--` are
 * positionals.
 */
const NO_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  config: new Set(["path", "check"]),
  laya: new Set(["install"]),
  linear: new Set(["doctor"]),
  label: new Set(["mark", "mark-where", "mark-last"]),
};

function refuseOptions(command: string, rest: readonly string[]): void {
  const verb = rest[0];
  if (verb === undefined || NO_OPTIONS[command]?.has(verb) !== true) return;
  for (const word of rest.slice(1)) {
    if (word === "--") return;
    if (word.startsWith("-") && word.length > 1)
      throw new CliUsageError(
        `Unknown option '${word}'; ${command} ${verb} takes no options`,
        command,
      );
  }
}

/** The help lines for a command, or the server usage when there is none. */
export function usageOf(command: string | undefined): string {
  const lines = help.split("\n");
  const commands = lines.indexOf("Commands:");
  const own =
    command === undefined
      ? []
      : lines
          .slice(commands + 1)
          .filter(
            (line) =>
              line.startsWith(`  ${command} `) || line === `  ${command}`,
          );
  if (own.length > 0) return `usage:\n${own.join("\n")}`;
  return lines.slice(2, commands).join("\n").trimEnd();
}

/** Whether an error is a bad command line (a usage error), as opposed to a check that could not run. */
function isUsageError(error: unknown): boolean {
  if (error instanceof CliUsageError) return true;
  return (
    error instanceof UsageError &&
    /^(?:usage:|Unknown option|Option '|Unexpected argument)/u.test(
      error.message,
    )
  );
}

/**
 * The message and exit code for an error that ended a command. Exit codes:
 * 0 success; 1 failure, a usage error (printed with the command's usage) or
 * a check that could not run; 2 only from `check` when it flagged its input.
 */
export function failureOf(
  error: unknown,
  arguments_: readonly string[],
): { readonly message: string; readonly exitCode: number } {
  const text = error instanceof Error ? error.message : String(error);
  if (isUsageError(error)) {
    const command =
      error instanceof CliUsageError && error.command !== undefined
        ? error.command
        : arguments_[0] !== undefined && !arguments_[0].startsWith("-")
          ? arguments_[0]
          : undefined;
    const usage = usageOf(
      command !== undefined &&
        (command in COMMANDS || ["hook", "linear", "laya"].includes(command))
        ? command
        : undefined,
    );
    return {
      message: text.startsWith("usage:") ? `${text}\n` : `${text}\n${usage}\n`,
      exitCode: 1,
    };
  }
  if (error instanceof UsageError || error instanceof ConfigError)
    return { message: `${text}\n`, exitCode: 1 };
  return { message: `vibecheck-linear-jev failed: ${text}\n`, exitCode: 1 };
}

const COMMANDS: Record<
  string,
  (args: string[], io: ToolIO) => Promise<number>
> = {
  measure: measureCommand,
  fixtures: fixturesCommand,
  label: labelCommand,
  check: checkCommand,
  "watch-agents": watchAgentsCommand,
  "exception-check": exceptionCheckCommand,
  "report-of": reportOfCommand,
  sources: sourcesCommand,
  config: configCommand,
  sync: syncCommand,
};

/** Runs a subcommand; returns its exit code, or undefined when the arguments are server options. */
export async function runCommand(
  arguments_: string[],
  environment: Environment,
): Promise<number | undefined> {
  const [command, ...rest] = arguments_;
  if (command === "hook") {
    const { values, positionals } = strictArgs("hook", () =>
      parseNodeArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: { client: { type: "string", default: "claude" } },
      }),
    );
    const name = positionals[0];
    const flag =
      values.client === "codex"
        ? "codex"
        : values.client === "muse"
          ? "muse"
          : values.client === "antigravity"
            ? "antigravity"
            : values.client === "claude"
              ? "claude"
              : undefined;
    if (name === undefined || !HOOKS.has(name) || flag === undefined)
      throw new CliUsageError(
        "usage: hook pretool|bash-guard|stop|session-end --client claude|codex|muse|antigravity",
      );
    const stdin = await readStdin();
    const client = detectClient(stdin, flag);
    ensureConfig(environment);
    const result = await runHook(name, client, stdin, environment);
    if (result.stdout !== undefined) process.stdout.write(result.stdout);
    if (result.stderr !== undefined) process.stderr.write(result.stderr);
    return result.exitCode;
  }
  const tool = command === undefined ? undefined : COMMANDS[command];
  if (command !== undefined) refuseOptions(command, rest);
  if (command === "linear") {
    ensureConfig(environment);
    if (rest[0] !== "doctor") throw new CliUsageError("usage: linear doctor");
    return linearDoctor(rest.slice(1), toolIO(environment));
  }
  if (command === "laya") {
    ensureConfig(environment);
    return layaCommand(rest, {
      ...toolIO(environment),
      config: loadConfig(environment),
    });
  }
  if (tool === undefined) return undefined;
  ensureConfig(environment);
  return tool(rest, toolIO(environment));
}

function openVerifier(
  config: Config,
  environment: Environment,
): LedgerVerifier | undefined {
  if (config.ledger?.verify === false) return undefined;
  const judgment = openJudgment(config, { environment, autostart: true });
  if (!isJudgment(judgment)) {
    process.stderr.write(
      `vibecheck-linear-jev: ledger checks are off: ${judgment.unusable.map((skip) => `${skip.sourceId}: ${skip.reason}`).join("; ")}\n`,
    );
    return undefined;
  }
  return new LedgerVerifier(judgment);
}

export async function main(
  arguments_: string[] = process.argv.slice(2),
): Promise<void> {
  if (arguments_.includes("--version")) {
    process.stdout.write(`vibecheck-linear-jev ${version}\n`);
    return;
  }
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  const code = await runCommand(arguments_, process.env);
  if (code !== undefined) {
    process.exitCode = code;
    return;
  }
  ensureConfig(process.env);
  let config: Config = {};
  try {
    config = loadConfig(process.env);
  } catch (error) {
    process.stderr.write(
      `vibecheck-linear-jev: ${error instanceof Error ? error.message : String(error)}; running with defaults and ledger checks off\n`,
    );
    config = { ledger: { verify: false } };
  }
  const options = parseArgs(arguments_, process.env, config);
  const verifier = openVerifier(config, process.env);
  const board = openBoard(options.database, config, process.env, verifier);
  const http =
    options.transport === "stdio"
      ? undefined
      : createHttpApp(board, {
          token: options.token,
          host: options.host,
          allowedHosts: options.allowedHosts,
          ...(options.projects === undefined
            ? {}
            : { projects: options.projects }),
        });
  const lifecycle =
    http ??
    serveStdio(() => createServer(board, options.projects), {
      onerror: () => process.stderr.write("MCP transport error.\n"),
    });
  try {
    if (http !== undefined)
      await new Promise<void>((resolveListening, reject) => {
        const failed = (error: Error) => reject(error);
        http.server.once("error", failed);
        http.server.listen(options.port, options.host, () => {
          http.server.off("error", failed);
          resolveListening();
        });
      });
    await new Promise<void>((resolveStopped) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.stdin.off("end", stop);
        resolveStopped();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (options.transport === "stdio") {
        process.stdin.once("end", stop);
        if (process.stdin.readableEnded) stop();
      }
    });
  } finally {
    await lifecycle.close();
    board.close();
  }
}

/**
 * Finds the key of every judgment source that reads one from an environment
 * variable: the variable, then the source's key file, then the interactive
 * shell. A config that does not parse is reported by main; the default
 * hosted source's key is still looked up here.
 */
async function loadSourceKeys(): Promise<void> {
  let sources: readonly SourceConfig[];
  try {
    sources = sourcesOf(loadConfig(process.env));
  } catch {
    sources = DEFAULT_SOURCES;
  }
  const done = new Set<string>();
  for (const source of sources) {
    if (source.kind === "laya" || source.auth?.apiKey !== undefined) continue;
    const name =
      source.auth?.apiKeyEnv ??
      (source.kind === "typesafe" ? "TYPESAFE_API_KEY" : undefined);
    if (name === undefined || done.has(name)) continue;
    done.add(name);
    const file = source.auth?.apiKeyFile;
    await loadKey(
      name,
      process.env,
      file === undefined ? undefined : expandHome(file),
    );
  }
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(entry)).href
) {
  try {
    const arguments_ = process.argv.slice(2);
    if (
      !["--version", "--help", "-h"].some((flag) => arguments_.includes(flag))
    )
      await loadSourceKeys();
    await main(arguments_);
    // A hook that answered on its budget may leave readings running; its
    // answer is written, so the process ends now instead of waiting on them.
    if (arguments_[0] === "hook") await exitAfterFlush();
  } catch (error) {
    const failure = failureOf(error, process.argv.slice(2));
    process.stderr.write(failure.message);
    process.exitCode = failure.exitCode;
  }
}
