// Finding an API key: the environment first, then a key file, then the
// environment of the user's interactive shell. Harnesses often start plugins
// without the variables a user exports in their shell rc files, so the shell
// read recovers them; it is bounded because an rc file can stall on anything,
// and every MCP start and hook run waits on it. A key's value never goes into
// a message, a warning or a thrown error.
//
// Every step is synchronous. Under Bun, a hook whose stdin is a file (a
// redirect, or a harness that passes the payload as a file) loses that stdin
// when the event loop turns before the hook first reads it, so the lookup
// that runs ahead of the hook must not wait on timers or I/O callbacks.

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** The variables a lookup reads; process.env by default. */
export type KeyEnvironment = Readonly<Record<string, string | undefined>>;

export interface FindKeyOptions {
  /** The environment variable that holds the key, e.g. TYPESAFE_API_KEY. */
  readonly envName: string;
  /** A file holding only the key; it must exist to be used. */
  readonly file?: string | undefined;
  readonly env?: KeyEnvironment | undefined;
  /** How long the interactive shell may take; 5 seconds by default. */
  readonly shellTimeoutMs?: number | undefined;
}

export type FoundKey =
  | { readonly value: string; readonly from: "env" | "file" | "shell" }
  | { readonly value: undefined; readonly tried: string[] };

/** The bound on the interactive shell read, as the old bash launcher had. */
export const SHELL_TIMEOUT_MS = 5_000;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Looks the key up in order: `env[envName]`, then `file`, then (not on
 * Windows) an interactive `$SHELL -ic` run (bash when SHELL is unset). The
 * shell prints the variable between two random markers, so whatever its rc
 * files print is ignored. It gets no stdin, runs with NO_AUTO_TMUX=1 in its
 * own process group, and the group is killed at the deadline. When nothing
 * is found, `tried` says what was looked at and why it gave nothing.
 */
export async function findKey(options: FindKeyOptions): Promise<FoundKey> {
  return findKeySync(options);
}

/** {@link findKey} without yielding to the event loop. */
export function findKeySync(options: FindKeyOptions): FoundKey {
  const { envName } = options;
  if (!VARIABLE_NAME.test(envName))
    throw new Error(`Not an environment variable name: ${envName}`);
  const env = options.env ?? process.env;
  const tried: string[] = [];

  const fromEnv = env[envName]?.trim();
  if (fromEnv !== undefined && fromEnv !== "")
    return { value: fromEnv, from: "env" };
  tried.push(`env ${envName} (${fromEnv === undefined ? "unset" : "empty"})`);

  if (options.file !== undefined) {
    const fromFile = readKeyFile(options.file);
    if (typeof fromFile === "string") return { value: fromFile, from: "file" };
    tried.push(`file ${options.file} (${fromFile.reason})`);
  }

  if (process.platform === "win32") {
    tried.push("shell (not read on Windows)");
    return { value: undefined, tried };
  }
  const shell = env["SHELL"]?.trim() || "bash";
  const fromShell = readShellVariable(
    shell,
    envName,
    env,
    options.shellTimeoutMs ?? SHELL_TIMEOUT_MS,
  );
  if (typeof fromShell === "string") return { value: fromShell, from: "shell" };
  tried.push(`shell ${shell} (${fromShell.reason})`);
  return { value: undefined, tried };
}

/**
 * Sets `env[envName]` from {@link findKey} when it is unset or empty. When
 * the interactive shell could not be read (it timed out, failed or could not
 * start) it says so on stderr, without the key, and continues without it.
 */
export async function loadKey(
  envName: string,
  env: Record<string, string | undefined> = process.env,
  file?: string,
): Promise<void> {
  if ((env[envName] ?? "").trim() !== "") return;
  const found = findKeySync({ envName, file, env });
  if (found.value !== undefined) {
    env[envName] = found.value;
    return;
  }
  const shell = found.tried.find((entry) => entry.startsWith("shell "));
  if (shell !== undefined && !shell.endsWith("(unset)"))
    process.stderr.write(
      `vibecheck-linear-jev: no ${envName} from the interactive ${shell}; continuing without it.\n`,
    );
}

/** The key in a key file, or undefined when it is missing, empty or unreadable. */
export function readKeyFileValue(path: string): string | undefined {
  const value = readKeyFile(path);
  return typeof value === "string" ? value : undefined;
}

interface Miss {
  readonly reason: string;
}

function readKeyFile(path: string): string | Miss {
  let mode: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) return { reason: "not a file" };
    mode = info.mode;
  } catch (error) {
    return { reason: errorCode(error) === "ENOENT" ? "missing" : "unreadable" };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { reason: "unreadable" };
  }
  const value = text.trim();
  if (value === "") return { reason: "empty" };
  if (process.platform !== "win32" && (mode & 0o044) !== 0)
    process.stderr.write(
      `vibecheck-linear-jev: ${path} can be read by other users; run chmod 600 on it.\n`,
    );
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function readShellVariable(
  shell: string,
  name: string,
  env: KeyEnvironment,
  timeoutMs: number,
): string | Miss {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && key !== name) childEnv[key] = value;
  childEnv["NO_AUTO_TMUX"] = "1";
  const marker = randomUUID().replaceAll("-", "");
  let result: Bun.SyncSubprocess<"pipe", "ignore">;
  try {
    result = Bun.spawnSync({
      cmd: [shell, "-ic", `printf '\\n${marker}%s${marker}\\n' "$${name}"`],
      env: childEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      // Its own process group, so the deadline also ends the jobs that the
      // rc files started in the background.
      detached: true,
    });
  } catch {
    return { reason: "could not start" };
  }
  if (result.exitedDueToTimeout === true) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {
      // the group has already gone
    }
    return { reason: `timed out after ${timeoutMs} ms` };
  }
  const output = result.stdout.toString("utf8");
  const start = output.indexOf(marker);
  const end = start < 0 ? -1 : output.indexOf(marker, start + marker.length);
  const value = end < 0 ? "" : output.slice(start + marker.length, end).trim();
  if (value !== "") return value;
  if (result.exitCode !== null && result.exitCode !== 0)
    return { reason: `exit ${result.exitCode}` };
  return { reason: "unset" };
}
