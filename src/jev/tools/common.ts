// Plumbing shared by the command-line tools.

import { parseArgs } from "node:util";
import { SqliteLocalStore } from "../../local/store.js";
import { defaultDatabase, type Environment } from "../../paths.js";
import { projectIdSchema, type ProjectId } from "../../schemas.js";
import { loadConfig, type Config } from "../config.js";
import {
  isJudgment,
  openJudgment,
  type Judgment,
  type JudgmentOptions,
} from "../judgment.js";

export interface ToolIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Environment;
  /** Overrides the configured chain, for tests. */
  readonly judgment?: Judgment;
  readonly config?: Config;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Opens the local store; the caller closes it. */
export function storeOf(io: ToolIO, override?: string): SqliteLocalStore {
  return new SqliteLocalStore(
    override ?? defaultDatabase(io.env, configOf(io).data ?? {}),
  );
}

/** Runs `work` with the local store open, closing it afterwards. */
export async function withStore<T>(
  io: ToolIO,
  work: (store: SqliteLocalStore) => T | Promise<T>,
): Promise<T> {
  const store = storeOf(io);
  try {
    return await work(store);
  } finally {
    store.close();
  }
}

export function configOf(io: ToolIO): Config {
  return io.config ?? loadConfig(io.env);
}

/** The chain for a tool run, or a usage error naming why no source is usable. */
export function judgmentOf(
  io: ToolIO,
  options: JudgmentOptions = {},
): Judgment {
  if (io.judgment !== undefined) return io.judgment;
  const opened = openJudgment(configOf(io), {
    environment: io.env,
    ...options,
  });
  if (isJudgment(opened)) return opened;
  throw new UsageError(
    `no judgment source is usable: ${opened.unusable.map((skip) => `${skip.sourceId}: ${skip.reason}`).join("; ")}`,
  );
}

export function projectOf(value: string | undefined): ProjectId | undefined {
  if (value === undefined) return undefined;
  const parsed = projectIdSchema.safeParse(value);
  if (!parsed.success) throw new UsageError(`not a project id: ${value}`);
  return parsed.data;
}

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

/** Parses a subcommand's arguments; a bad flag is a usage error. */
export function parse<const O extends Options>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}
