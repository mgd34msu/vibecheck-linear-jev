// Configuration: one JSON-with-comments file shared by the Claude Code,
// Codex, and Muse installs, like the local store. It holds the judgment sources in
// the order they are tried, each check's switch, thresholds and routing, the
// hook deadlines, the data folder and database path, and the Linear settings
// (team, where the API key comes from, workflow state names, re-check bound).
//
// With no file, every default applies: the hosted TypeSafe source keyed by
// TYPESAFE_API_KEY, every check on at its built-in thresholds. Validation
// errors name the file, the key and what was expected.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { configFile, type Environment } from "../paths.js";

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_LAYA_PORT = 8723;

/** Laya's published input limits for the English checkpoint. */
export const LAYA_LIMITS = {
  maxStateTokens: 512,
  maxOptionTokens: 192,
  maxOptions: 20,
};

/** The Jev-Style adapter's limit on total input. */
export const JEV_STYLE_LIMITS = { maxStateTokens: 25_600 };

/** How long a hook waits for its readings before it lets the work go ahead. */
export const DEFAULT_HOOK_SECONDS = { briefCheck: 40, stop: 40 };

const identifier = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u,
    "expected letters, digits, '.', '_' or '-'",
  );

const authSchema = z
  .strictObject({
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z
      .string()
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/u,
        "expected an environment variable name",
      )
      .optional(),
    /** A file holding only the key, mode 0600; read after the environment variable. */
    apiKeyFile: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .refine(
    (auth) =>
      auth.apiKey === undefined ||
      (auth.apiKeyEnv === undefined && auth.apiKeyFile === undefined),
    {
      message: "expected apiKey or apiKeyEnv/apiKeyFile, not both",
      path: ["apiKey"],
    },
  );

const limitsSchema = z.strictObject({
  maxStateTokens: z.number().int().positive().optional(),
  maxOptionTokens: z.number().int().positive().optional(),
  maxOptions: z.number().int().positive().optional(),
});

const common = {
  id: identifier,
  timeoutMs: z.number().int().positive().optional(),
  limits: limitsSchema.optional(),
};

const url = z.url({ message: "expected a URL such as http://127.0.0.1:8000" });

export const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("typesafe"),
    ...common,
    baseURL: url.optional(),
    auth: authSchema.optional(),
    model: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("openjev"),
    ...common,
    baseURL: url,
    auth: authSchema.optional(),
    model: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("laya"),
    ...common,
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    model: z.string().min(1).optional(),
    autostart: z.boolean().optional(),
    load: z
      .strictObject({
        modelDir: z.string().optional(),
        repo: z.string().optional(),
        subfolder: z.string().optional(),
        revision: z.string().optional(),
        cacheDir: z.string().optional(),
        token: z.string().optional(),
        executionProviders: z.array(z.string()).optional(),
        intraOpNumThreads: z.number().int().positive().optional(),
      })
      .optional(),
  }),
]);
export type SourceConfig = z.infer<typeof sourceSchema>;

const probability = z
  .number()
  .min(0, "expected a probability from 0 to 1")
  .max(1, "expected a probability from 0 to 1");

export const checkSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  thresholds: z.record(z.string(), probability).optional(),
  /** Source ids that answer this check, in order; null or absent means every source. */
  sources: z.array(z.string()).min(1).nullable().optional(),
  /** Threshold overrides that apply only when the named source answers. */
  sourceThresholds: z
    .record(z.string(), z.record(z.string(), probability))
    .optional(),
});
export type CheckSettings = z.infer<typeof checkSettingsSchema>;

const seconds = z.number().positive().max(600);

const stateName = z.string().min(1).nullable().optional();

export const linearConfigSchema = z.strictObject({
  /** Team key, e.g. `TA`; null means the only team the key sees. */
  team: z.string().min(1).nullable().optional(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "expected an environment variable name")
    .optional(),
  /** A file holding only the key, mode 0600. */
  apiKeyFile: z.string().min(1).nullable().optional(),
  states: z
    .strictObject({
      inProgress: stateName,
      review: stateName,
      done: stateName,
      canceled: stateName,
    })
    .optional(),
  reconcile: z
    .strictObject({ maxRechecks: z.number().int().min(0).max(100).optional() })
    .optional(),
});
export type LinearConfig = z.infer<typeof linearConfigSchema>;

/** Done re-checks one reconciler run performs when config sets none. */
export const DEFAULT_MAX_RECHECKS = 10;

export const configSchema = z
  .strictObject({
    sources: z.array(sourceSchema).min(1).optional(),
    checks: z.record(z.string(), checkSettingsSchema).optional(),
    ledger: z.strictObject({ verify: z.boolean().optional() }).optional(),
    hooks: z
      .strictObject({
        briefCheck: z.boolean().optional(),
        bashGuard: z.boolean().optional(),
        stop: z.boolean().optional(),
        briefCheckSeconds: seconds.optional(),
        stopSeconds: seconds.optional(),
      })
      .optional(),
    data: z
      .strictObject({
        folder: z.string().min(1).nullable().optional(),
        database: z.string().min(1).nullable().optional(),
      })
      .optional(),
    linear: linearConfigSchema.optional(),
  })
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, source] of (config.sources ?? []).entries()) {
      if (ids.has(source.id))
        context.addIssue({
          code: "custom",
          message: `expected a unique source id; ${source.id} appears twice`,
          path: ["sources", index, "id"],
        });
      ids.add(source.id);
    }
    const known = ids.size === 0 ? new Set(["typesafe"]) : ids;
    for (const [check, settings] of Object.entries(config.checks ?? {})) {
      for (const [index, id] of (settings.sources ?? []).entries())
        if (!known.has(id))
          context.addIssue({
            code: "custom",
            message: `expected a configured source id, got ${id}`,
            path: ["checks", check, "sources", index],
          });
      for (const id of Object.keys(settings.sourceThresholds ?? {}))
        if (!known.has(id))
          context.addIssue({
            code: "custom",
            message: `expected a configured source id, got ${id}`,
            path: ["checks", check, "sourceThresholds", id],
          });
    }
  });
export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** One clause per problem, each naming the key and what was expected. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "(top level)"}: ${issue.message}`,
    )
    .join("; ");
}

/**
 * JSON with comments to plain JSON: drops // and /* *\/ comments and
 * trailing commas outside strings. Quoted text, escapes included, passes
 * through unchanged.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"')
        end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  let result = "";
  index = 0;
  while (index < out.length) {
    const char = out[index] ?? "";
    if (char === '"') {
      let end = index + 1;
      while (end < out.length && out[end] !== '"')
        end += out[end] === "\\" ? 2 : 1;
      result += out.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === ",") {
      let ahead = index + 1;
      while (ahead < out.length && /\s/u.test(out[ahead] ?? "")) ahead += 1;
      if (out[ahead] === "}" || out[ahead] === "]") {
        index += 1;
        continue;
      }
    }
    result += char;
    index += 1;
  }
  return result;
}

export function parseConfig(value: unknown, where = "config"): Config {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success)
    throw new ConfigError(`${where}: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

export function parseConfigText(text: string, where: string): Config {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new ConfigError(
      `${where}: not valid JSON with comments (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseConfig(value, where);
}

/** Reads the config file; a missing file is the default configuration. */
export function loadConfig(environment: Environment = process.env): Config {
  const path = configFile(environment);
  if (!existsSync(path)) return {};
  return parseConfigText(readFileSync(path, "utf8"), path);
}

export const DEFAULT_SOURCES: readonly SourceConfig[] = [
  { kind: "typesafe", id: "typesafe" },
];

export function sourcesOf(config: Config): readonly SourceConfig[] {
  return config.sources ?? DEFAULT_SOURCES;
}

/** Whether a check is turned on in this configuration. */
export function checkEnabled(config: Config, batteryId: string): boolean {
  return config.checks?.[batteryId]?.enabled !== false;
}

/** Threshold overrides for a check read from a source: the check's values, then that source's over them. */
export function thresholdsFor(
  config: Config,
): (
  batteryId: string,
  sourceId: string,
) => Readonly<Record<string, number>> | undefined {
  return (batteryId, sourceId) => {
    const settings = config.checks?.[batteryId];
    const general = settings?.thresholds;
    const source = settings?.sourceThresholds?.[sourceId];
    if (general === undefined && source === undefined) return undefined;
    return { ...general, ...source };
  };
}

/** Per-check routing: check id to the source ids that answer it. */
export function routesOf(config: Config): Map<string, readonly string[]> {
  const routes = new Map<string, readonly string[]>();
  for (const [check, settings] of Object.entries(config.checks ?? {}))
    if (settings.sources !== undefined && settings.sources !== null)
      routes.set(check, settings.sources);
  return routes;
}
