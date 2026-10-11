// The config file on disk: the pre-populated template written on first run,
// and the `config path` and `config init --force` commands.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile, type Environment } from "../paths.js";
import {
  DEFAULT_HOOK_SECONDS,
  DEFAULT_LAYA_PORT,
  loadConfig,
} from "./config.js";
import { BATTERIES } from "./registry.js";
import { parse, UsageError, type ToolIO } from "./tools/common.js";

function line(comment: string): string {
  return `  // ${comment}`;
}

/** What raising a check's thresholds does, written under its purpose. */
const THRESHOLD_NOTES: Readonly<Record<string, string>> = {
  "vibecheck.done-admits-unfinished":
    "blockAt: the reading at which a completion is held because its report says part of the task is not done; raise it to hold only clear admissions.",
};

/** The whole config with every option at its default and a comment above each. */
export function configTemplate(): string {
  const checks = BATTERIES.map((battery, index) => {
    const thresholds = Object.entries(battery.thresholds)
      .map(([name, value]) => `"${name}": ${value}`)
      .join(", ");
    const note = THRESHOLD_NOTES[battery.id];
    return [
      `    // ${battery.purpose}`,
      ...(note === undefined ? [] : [`    // ${note}`]),
      `    "${battery.id}": {`,
      `      "enabled": true,`,
      `      "thresholds": { ${thresholds} },`,
      `      // Source ids that answer this check, in order; null means every source.`,
      `      "sources": null`,
      `    }${index === BATTERIES.length - 1 ? "" : ","}`,
    ].join("\n");
  }).join("\n");
  const codeChecks = [
    [
      "vibecheck.commit-paths",
      "When a claim marks work complete with a commit and a readable checkout: whether the commit changed any claimed path. A miss keeps the task open.",
    ],
    [
      "vibecheck.exception-check",
      "When a task's accepted exception says a file holds data or text only: whether the file holds control flow. Logic there keeps the task open.",
    ],
    [
      "vibecheck.parent-rollup",
      "When a task with children is marked complete: whether every child verified. An unverified child keeps the parent open.",
    ],
    [
      "vibecheck.plan-detail",
      "On plan_publish, plan_edit and issue_adopt: whether a task's goal or criteria are vague (vague phrases, short goals, missing criteria). A flag asks for a rewrite.",
    ],
  ]
    .map(
      ([id, purpose]) =>
        `    // ${purpose ?? ""}\n    "${id ?? ""}": { "enabled": true }`,
    )
    .join(",\n");
  return `// vibecheck-linear-jev configuration, shared by the Claude Code, Codex, and Muse installs.
// Written on first run with every option at its default. Edit freely; the
// file is never overwritten. \`vibecheck-linear-jev config init --force\` rewrites it
// after saving the old one next to it.
{
${line("Judgment sources, tried in order. When one is unreachable, rate limited or")}
${line("times out, the next answers; an auth failure or invalid request stops there.")}
${line("Kinds: typesafe (hosted Jev), openjev (any server speaking the Jev wire API,")}
${line("including the Jev-Style adapter) and laya (the local Laya server).")}
  "sources": [
    // Hosted Jev. The key is looked up in this order: the environment variable
    // TYPESAFE_API_KEY (or the name in auth.apiKeyEnv), then the file named by
    // auth.apiKeyFile, then your interactive shell's environment. Example:
    // "auth": { "apiKeyEnv": "MY_JEV_KEY", "apiKeyFile": "~/.config/typesafe/key" }
    { "kind": "typesafe", "id": "typesafe", "model": "jev-latest" }
    // An open Jev-compatible server:
    // , { "kind": "openjev", "id": "local-jev", "baseURL": "http://127.0.0.1:8000", "model": "jev" }
    // Laya, served by \`vibecheck-linear-jev laya serve\` (install it first with \`laya install\`):
    // , { "kind": "laya", "id": "laya", "port": ${DEFAULT_LAYA_PORT}, "autostart": false }
    // The Jev-Style adapter from adapters/jev-style, run by you:
    // , { "kind": "openjev", "id": "jev-style", "baseURL": "http://127.0.0.1:8766", "model": "jev-style", "limits": { "maxStateTokens": 25600 } }
  ],

${line("Each check: turn it off with enabled false, change its thresholds (each a")}
${line("probability from 0 to 1), route it to particular sources, or override a")}
${line('threshold for one source with sourceThresholds: { "<source id>": { ... } }.')}
  "checks": {
${checks},
    // Checks decided by code, with no reading; each can be turned off.
${codeChecks}
  },

${line("Checks the ledger runs on work_update, work_claim, plan_publish, plan_edit")}
${line("and issue_adopt, and on issues people mark done in Linear.")}
${line("When false, the ledger records work as reported, like a plain ledger.")}
  "ledger": { "verify": true },

${line("Hooks. Turn one off, or change how many seconds a hook waits for its readings")}
${line("before it lets the work go ahead. Keep these under the client's hook timeout")}
${line("(45 seconds for the brief check and the Stop check).")}
  "hooks": {
    "briefCheck": true,
    "bashGuard": true,
    "stop": true,
    "briefCheckSeconds": ${DEFAULT_HOOK_SECONDS.briefCheck},
    "stopSeconds": ${DEFAULT_HOOK_SECONDS.stop}
  },

${line("Where data lives. null means the default: $XDG_DATA_HOME/vibecheck-linear-jev or")}
${line("~/.local/share/vibecheck-linear-jev, with the local store at state.sqlite3 inside it.")}
${line("VIBECHECK_LINEAR_JEV_DB overrides the database path.")}
  "data": {
    "folder": null,
    "database": null
  },

${line("Linear. The tool writes with your personal API key.")}
  "linear": {
    // Team key, e.g. "TA". null means the only team the key can see; with
    // several teams, project_join asks for one.
    "team": null,
    // The environment variable holding the key. When it is unset, the key is
    // read from apiKeyFile, then from your interactive shell's environment.
    "apiKeyEnv": "LINEAR_API_KEY",
    // A file holding only the key (chmod 600). null means none.
    "apiKeyFile": null,
    // Workflow state names to use instead of the defaults: the first started
    // state, the first started state whose name contains "review", the first
    // completed state, the first canceled state.
    "states": { "inProgress": null, "review": null, "done": null, "canceled": null },
    // Issues people mark done in Linear get a done re-check; at most this many
    // per run, the rest wait for the next run.
    "reconcile": { "maxRechecks": 10 }
  }
}
`;
}

/** Writes the template when no config file exists; never overwrites one. Returns the path. */
export function ensureConfig(environment: Environment): string {
  const path = configFile(environment);
  if (existsSync(path)) return path;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, configTemplate(), { flag: "wx" });
  } catch {
    // Another process wrote it first, or the folder is read-only: defaults apply.
  }
  return path;
}

export async function configCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const [verb, ...rest] = args;
  const path = configFile(io.env);
  if (verb === "path") {
    io.out(path);
    return 0;
  }
  if (verb === "init") {
    const { values } = parse(rest, { force: { type: "boolean" } });
    if (existsSync(path)) {
      if (values.force !== true) {
        io.err(
          `${path} exists; use config init --force to rewrite it (the old file is kept as a backup)`,
        );
        return 1;
      }
      const backup = `${path}.${new Date().toISOString().replace(/[:.]/gu, "-")}.bak`;
      copyFileSync(path, backup);
      io.out(`saved the old file as ${backup}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, configTemplate());
    io.out(`wrote ${path}`);
    return 0;
  }
  if (verb === "check") {
    loadConfig(io.env);
    io.out(`${path}: ${existsSync(path) ? "valid" : "absent; defaults apply"}`);
    return 0;
  }
  throw new UsageError(
    "usage: config path | config init [--force] | config check",
  );
}
