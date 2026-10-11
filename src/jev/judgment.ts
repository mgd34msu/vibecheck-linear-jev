// The judgment source chain built from configuration, and the runner every
// check goes through: it applies the user's disabled checks and per-source
// thresholds, and turns an unreachable chain into an "unavailable" result
// instead of a verdict.

import { spawn } from "node:child_process";
import type { TypeSafeClientConfig } from "@typesafe-ai/sdk";
import {
  checkEnabled,
  DEFAULT_LAYA_PORT,
  LAYA_LIMITS,
  routesOf,
  sourcesOf,
  thresholdsFor,
  TYPESAFE_BASE_URL,
  type Config,
  type SourceConfig,
} from "./config.js";
import {
  CachingProvider,
  FailoverProvider,
  JevProvider,
  runBattery,
  type Battery,
  type BatteryRun,
  type ChainSource,
  type Decision,
  type Questions,
  type SourceSkip,
  type SystemOneProvider,
  type ThresholdResolver,
} from "./lib/index.js";
import { readKeyFileValue } from "../keys.js";
import { expandHome, type Environment } from "../paths.js";

export interface ResolvedSource {
  readonly config: SourceConfig;
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type SourceResolution =
  | { readonly ok: true; readonly source: ResolvedSource }
  | { readonly ok: false; readonly id: string; readonly reason: string };

/** Resolves a source's endpoint, model and credentials from config and environment. */
export function resolveSource(
  source: SourceConfig,
  environment: Environment,
): SourceResolution {
  const auth = source.kind === "laya" ? undefined : source.auth;
  // The key's value never goes into a reason.
  const envName =
    auth?.apiKeyEnv ??
    (source.kind === "typesafe" ? "TYPESAFE_API_KEY" : undefined);
  const fromEnv =
    envName === undefined ? undefined : environment[envName]?.trim();
  const fromFile =
    auth?.apiKeyFile === undefined
      ? undefined
      : readKeyFileValue(expandHome(auth.apiKeyFile));
  const apiKey =
    auth?.apiKey ??
    (fromEnv === undefined || fromEnv === "" ? undefined : fromEnv) ??
    fromFile;
  const wantsKey =
    auth?.apiKeyEnv !== undefined || auth?.apiKeyFile !== undefined;
  if (wantsKey && apiKey === undefined)
    return {
      ok: false,
      id: source.id,
      reason: `no API key: ${[
        auth?.apiKeyEnv === undefined
          ? undefined
          : `environment variable ${auth.apiKeyEnv} is not set`,
        auth?.apiKeyFile === undefined
          ? undefined
          : `key file ${auth.apiKeyFile} gave nothing`,
      ]
        .filter((part) => part !== undefined)
        .join(", ")}`,
    };
  const headers = auth?.headers;
  switch (source.kind) {
    case "typesafe": {
      if (apiKey === undefined && headers === undefined)
        return {
          ok: false,
          id: source.id,
          reason: `no API key: set ${envName ?? "TYPESAFE_API_KEY"}, or give auth.apiKeyFile or auth in the config`,
        };
      return {
        ok: true,
        source: {
          config: source,
          baseURL: source.baseURL ?? TYPESAFE_BASE_URL,
          model: source.model ?? "jev-latest",
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(headers === undefined ? {} : { headers }),
        },
      };
    }
    case "openjev":
      return {
        ok: true,
        source: {
          config: source,
          baseURL: source.baseURL,
          model: source.model,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(headers === undefined ? {} : { headers }),
        },
      };
    case "laya":
      return {
        ok: true,
        source: {
          config: source,
          baseURL: `http://${source.host ?? "127.0.0.1"}:${source.port ?? DEFAULT_LAYA_PORT}`,
          model: source.model ?? "laya",
        },
      };
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function limitsOf(source: SourceConfig) {
  return source.kind === "laya"
    ? { ...LAYA_LIMITS, ...source.limits }
    : source.limits;
}

export interface JudgmentOptions {
  readonly environment?: Environment;
  /** Use only this source, for calibration and connection checks. */
  readonly onlySource?: string;
  readonly cached?: boolean;
  readonly timeoutMs?: number;
  readonly fetch?: TypeSafeClientConfig["fetch"];
  /** Start a configured Laya server that is not running (hooks and the ledger). */
  readonly autostart?: boolean;
}

export interface Judgment {
  readonly provider: SystemOneProvider;
  readonly config: Config;
  readonly thresholdsFor: ThresholdResolver;
  readonly sources: readonly ResolvedSource[];
  /** Sources left out of the chain and why (no key, not selected). */
  readonly unusable: readonly SourceSkip[];
}

/** The configured chain, or undefined with the reasons when no source is usable. */
export function openJudgment(
  config: Config,
  options: JudgmentOptions = {},
): Judgment | { readonly unusable: readonly SourceSkip[] } {
  const environment = options.environment ?? process.env;
  const unusable: SourceSkip[] = [];
  const resolved: ResolvedSource[] = [];
  for (const source of sourcesOf(config)) {
    if (options.onlySource !== undefined && source.id !== options.onlySource)
      continue;
    const resolution = resolveSource(source, environment);
    if (resolution.ok) resolved.push(resolution.source);
    else unusable.push({ sourceId: resolution.id, reason: resolution.reason });
  }
  if (
    options.onlySource !== undefined &&
    resolved.length === 0 &&
    unusable.length === 0
  )
    unusable.push({
      sourceId: options.onlySource,
      reason: "no source with this id is configured",
    });
  if (resolved.length === 0) return { unusable };
  const chain: ChainSource[] = resolved.map((source) => {
    const limits = limitsOf(source.config);
    return {
      provider: new JevProvider({
        id: source.config.id,
        baseURL: source.baseURL,
        model: source.model,
        timeoutMs:
          options.timeoutMs ??
          source.config.timeoutMs ??
          defaultTimeout(source),
        ...(source.apiKey === undefined ? {} : { apiKey: source.apiKey }),
        ...(source.headers === undefined ? {} : { headers: source.headers }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      ...(limits === undefined ? {} : { limits }),
    };
  });
  if (options.autostart === true)
    for (const source of resolved)
      if (source.config.kind === "laya" && source.config.autostart === true)
        void ensureLayaServer(source);
  const routes =
    options.onlySource === undefined ? routesOf(config) : new Map();
  const failover = new FailoverProvider(chain, routes);
  return {
    provider:
      options.cached === false ? failover : new CachingProvider(failover),
    config,
    thresholdsFor: thresholdsFor(config),
    sources: resolved,
    unusable,
  };
}

function defaultTimeout(source: ResolvedSource): number {
  return source.config.kind === "laya" ? 60_000 : 25_000;
}

export function isJudgment(
  value: Judgment | { readonly unusable: readonly SourceSkip[] },
): value is Judgment {
  return "provider" in value;
}

/** Starts `laya serve` in the background when a configured Laya server does not answer. */
async function ensureLayaServer(source: ResolvedSource): Promise<void> {
  try {
    const response = await fetch(`${source.baseURL}/v1/models`, {
      signal: AbortSignal.timeout(300),
    });
    if (response.ok) return;
  } catch {
    // not running: start it below
  }
  const entry = process.argv[1];
  if (entry === undefined) return;
  const child = spawn(
    process.execPath,
    [entry, "laya", "serve", "--source", source.config.id],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.on("error", () => {});
  child.unref();
}

// ---------------------------------------------------------------------------
// Running one check
// ---------------------------------------------------------------------------

export type CheckResult<Q extends Questions, D> =
  | { readonly kind: "verdict"; readonly run: BatteryRun<Q, D> }
  | { readonly kind: "unavailable"; readonly error: string }
  | { readonly kind: "disabled" };

export async function runCheck<
  I,
  Q extends Questions,
  K extends string,
  D extends Decision,
>(
  judgment: Judgment,
  battery: Battery<I, Q, K, D>,
  input: I,
): Promise<CheckResult<Q, D>> {
  if (!checkEnabled(judgment.config, battery.id)) return { kind: "disabled" };
  try {
    const run = await runBattery(battery, input, {
      provider: judgment.provider,
      thresholdsFor: judgment.thresholdsFor,
    });
    return { kind: "verdict", run };
  } catch (error) {
    return {
      kind: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
