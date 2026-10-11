// Verifies a release: manifest versions and command shapes for each harness,
// bundle and notice freshness, checksums, archive inventories and modes, and
// a full MCP lifecycle plus the hooks of every harness's plugin, run under
// Bun from the source tree, the platform units and the extracted archives.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  chmod,
  cp,
  lstat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  ANTIGRAVITY_HOOKS,
  ANTIGRAVITY_MANIFESTS,
  artifactNames,
  BUNDLE,
  commonFiles,
  generateBundle,
  generateNotices,
  hookFile,
  MUSE_HOOKS,
  packageVersion,
  platformDir,
  platforms,
  pluginFiles,
  PRODUCT,
  root,
  run,
  sha256,
} from "./build-release.js";
import type { Platform } from "./build-release.js";

const toolNames = [
  "project_join",
  "plan_publish",
  "plan_edit",
  "plan_ack",
  "plan_read",
  "issue_adopt",
  "work_claim",
  "work_update",
  "project_status",
  "work_history",
  "project_update",
].sort();
const manifestSchema = z.object({
  name: z.literal(PRODUCT),
  version: z.string(),
  hooks: z.string().optional(),
  mcpServers: z.object({
    "vibecheck-linear-jev": z.object({
      command: z.literal("bun"),
      args: z.array(z.string()),
      cwd: z.string().optional(),
    }),
  }),
});
const hooksSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(
      z.object({
        matcher: z.string().optional(),
        hooks: z.array(
          z.object({
            type: z.literal("command"),
            command: z.string(),
            commandWindows: z.string().optional(),
            timeout: z.number().int().positive(),
          }),
        ),
      }),
    ),
  ),
});
const museHookSchema = z.object({
  id: z.string(),
  event: z.string(),
  command: z.array(z.string()),
  timeoutMs: z.number().int().positive(),
});
const museManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.literal(PRODUCT),
  version: z.string(),
  capabilities: z.object({
    skills: z.tuple([
      z.object({
        id: z.literal(PRODUCT),
        path: z.literal("skills/vibecheck-linear-jev/SKILL.md"),
      }),
    ]),
    hooks: z.tuple([
      museHookSchema,
      museHookSchema,
      museHookSchema,
      museHookSchema,
    ]),
    mcpServers: z.tuple([
      z.object({
        id: z.literal(PRODUCT),
        transport: z.literal("stdio"),
        command: z.tuple([
          z.literal("bun"),
          z.literal(BUNDLE),
          z.literal("--transport"),
          z.literal("stdio"),
        ]),
      }),
    ]),
  }),
});

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const antigravityManifestSchema = z.object({
  name: z.literal(PRODUCT),
  displayName: z.string(),
  description: z.string(),
  version: z.string(),
  suggestedPrompts: z.array(z.string()),
});
const antigravityMcpSchema = z.object({
  mcpServers: z.object({
    "vibecheck-linear-jev": z.object({
      command: z.literal("bun"),
      args: z.tuple([
        z.literal(BUNDLE),
        z.literal("--transport"),
        z.literal("stdio"),
      ]),
    }),
  }),
});
const antigravityHandlerSchema = z.object({
  type: z.literal("command"),
  command: z.string(),
  timeout: z.number().int().positive(),
});
const antigravityHooksSchema = z.object({
  "vibecheck-linear-jev": z.object({
    PreToolUse: z.tuple([
      z.object({
        matcher: z.literal("invoke_subagent|send_message|manage_task"),
        hooks: z.tuple([antigravityHandlerSchema]),
      }),
      z.object({
        matcher: z.literal("run_command"),
        hooks: z.tuple([antigravityHandlerSchema]),
      }),
    ]),
    Stop: z.tuple([antigravityHandlerSchema]),
  }),
});

async function verifyAntigravityManifest(
  directory: string,
  version: string,
): Promise<void> {
  const manifest = antigravityManifestSchema.parse(
    await json(join(directory, "plugin.json")),
  );
  assert.equal(manifest.version, version);
  antigravityMcpSchema.parse(await json(join(directory, "mcp_config.json")));
  const hooks = antigravityHooksSchema.parse(
    await json(join(directory, "hooks.json")),
  );
  assert.deepEqual(
    [
      hooks["vibecheck-linear-jev"].PreToolUse[0].hooks[0].command,
      hooks["vibecheck-linear-jev"].PreToolUse[1].hooks[0].command,
      hooks["vibecheck-linear-jev"].Stop[0].command,
    ],
    [
      "bun hooks/antigravity-pretool.mjs",
      "bun hooks/antigravity-bash-guard.mjs",
      "bun hooks/antigravity-stop.mjs",
    ],
  );
  assert.deepEqual([...ANTIGRAVITY_MANIFESTS].sort(), [
    "hooks.json",
    "mcp_config.json",
    "plugin.json",
  ]);
  assert.deepEqual([...ANTIGRAVITY_HOOKS].sort(), [
    "hooks/antigravity-bash-guard.mjs",
    "hooks/antigravity-pretool.mjs",
    "hooks/antigravity-stop.mjs",
  ]);
  await verifyWrappers(directory, "antigravity", [
    ["hooks/antigravity-pretool.mjs", "pretool"],
    ["hooks/antigravity-bash-guard.mjs", "bash-guard"],
    ["hooks/antigravity-stop.mjs", "stop"],
  ]);
}

/** Each hook wrapper runs its own hook of the bundled runtime. */
async function verifyWrappers(
  directory: string,
  client: Platform,
  wrappers: [string, string][],
): Promise<void> {
  for (const [wrapper, hook] of wrappers) {
    const script = await readFile(join(directory, wrapper), "utf8");
    assert.ok(
      script.includes('"vibecheck-linear-jev.mjs"') &&
        script.includes(`"hook", "${hook}", "--client", "${client}"`),
      `${wrapper} runs ${hook} through the bundled runtime`,
    );
  }
}

async function verifyMuseManifest(
  directory: string,
  version: string,
): Promise<void> {
  const manifest = museManifestSchema.parse(
    await json(join(directory, ".muse-plugin/plugin.json")),
  );
  assert.equal(manifest.version, version);
  assert.deepEqual(
    manifest.capabilities.hooks.map((hook) => [
      hook.id,
      hook.event,
      hook.command,
    ]),
    [
      ["pretool", "PreToolUse", ["bun", "hooks/muse-pretool.mjs"]],
      ["bash-guard", "PreToolUse", ["bun", "hooks/muse-bash-guard.mjs"]],
      [
        "subagent-stop",
        "SubagentStop",
        ["bun", "hooks/muse-subagent-stop.mjs"],
      ],
      ["session-end", "SessionEnd", ["bun", "hooks/muse-session-end.mjs"]],
    ],
  );
  assert.deepEqual([...MUSE_HOOKS].sort(), [
    "hooks/muse-bash-guard.mjs",
    "hooks/muse-pretool.mjs",
    "hooks/muse-session-end.mjs",
    "hooks/muse-subagent-stop.mjs",
  ]);
  await verifyWrappers(directory, "muse", [
    ["hooks/muse-pretool.mjs", "pretool"],
    ["hooks/muse-bash-guard.mjs", "bash-guard"],
    ["hooks/muse-subagent-stop.mjs", "stop"],
    ["hooks/muse-session-end.mjs", "session-end"],
  ]);
  assert.ok(
    !(await readdir(directory)).includes("marketplace.json"),
    "a root marketplace.json hijacks Muse probe #1; Muse must derive via the codex catalog",
  );
}

export async function verifyVersions(directory: string): Promise<string> {
  const version = await packageVersion(directory);
  for (const platform of platforms) {
    if (platform === "muse") {
      await verifyMuseManifest(directory, version);
      continue;
    }
    if (platform === "antigravity") {
      await verifyAntigravityManifest(directory, version);
      continue;
    }
    const manifest = manifestSchema.parse(
      await json(join(directory, `.${platform}-plugin/plugin.json`)),
    );
    assert.equal(manifest.version, version);
    const catalog = z
      .object({
        name: z.literal(PRODUCT),
        plugins: z
          .array(z.object({ name: z.literal(PRODUCT), source: z.unknown() }))
          .length(1),
      })
      .parse(
        await json(
          join(
            directory,
            platform === "codex"
              ? ".agents/plugins/marketplace.json"
              : ".claude-plugin/marketplace.json",
          ),
        ),
      );
    assert.deepEqual(
      catalog.plugins[0]?.source,
      // Codex stays whole-tree: Muse derives installs via this catalog and
      // cannot follow it into a subdir (its native catalog digests are
      // unverifiable by hand). Claude takes the isolated unit.
      platform === "codex"
        ? { source: "local", path: "./" }
        : "./platforms/claude",
    );
    assert.deepEqual(manifest.mcpServers["vibecheck-linear-jev"].args, [
      platform === "codex" ? BUNDLE : `\${CLAUDE_PLUGIN_ROOT}/${BUNDLE}`,
      "--transport",
      "stdio",
    ]);
    assert.equal(
      manifest.mcpServers["vibecheck-linear-jev"].cwd,
      platform === "codex" ? "." : undefined,
    );
    const hooksPath = hookFile(platform);
    assert.ok(typeof hooksPath === "string");
    assert.equal(
      manifest.hooks,
      platform === "codex" ? `./${hooksPath}` : undefined,
    );
    const hooks = hooksSchema.parse(await json(join(directory, hooksPath)));
    const root =
      platform === "codex" ? "$PLUGIN_ROOT" : "${CLAUDE_PLUGIN_ROOT}";
    for (const [event, groups] of Object.entries(hooks.hooks))
      for (const group of groups)
        for (const hook of group.hooks) {
          assert.ok(
            hook.command.startsWith(`bun "${root}/${BUNDLE}" hook `),
            `${platform} ${event} hook runs the bundled runtime with bun`,
          );
          assert.equal(
            hook.commandWindows?.startsWith(
              `bun "%PLUGIN_ROOT%\\${BUNDLE.replaceAll("/", "\\")}" hook `,
            ) ?? false,
            platform === "codex",
            `${platform} ${event} hook has a Windows command only for Codex`,
          );
        }
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PreToolUse", "Stop"]);
  }
  const skill = await readFile(
    join(directory, "skills/vibecheck-linear-jev/SKILL.md"),
    "utf8",
  );
  assert.match(
    skill,
    /^---\nname: vibecheck-linear-jev\ndescription: .+\n---\n/u,
  );
  return version;
}

export async function exercisePlugin(
  directory: string,
  platform: Platform,
  database: string,
  workingDirectory: string,
  expectedVersion: string,
): Promise<void> {
  let command: string;
  let arguments_: string[];
  let cwd: string;
  if (platform === "muse") {
    const manifest = museManifestSchema.parse(
      await json(join(directory, ".muse-plugin/plugin.json")),
    );
    const [entry, script, ...flags] =
      manifest.capabilities.mcpServers[0].command;
    command = entry;
    arguments_ = [resolve(directory, script), ...flags];
    cwd = workingDirectory;
  } else if (platform === "antigravity") {
    const config = antigravityMcpSchema.parse(
      await json(join(directory, "mcp_config.json")),
    );
    const server = config.mcpServers["vibecheck-linear-jev"];
    const [script, ...flags] = server.args;
    command = server.command;
    arguments_ = [resolve(directory, script), ...flags];
    cwd = directory;
  } else {
    const manifest = manifestSchema.parse(
      await json(join(directory, `.${platform}-plugin/plugin.json`)),
    );
    const server = manifest.mcpServers["vibecheck-linear-jev"];
    arguments_ = server.args.map((value) =>
      value.replaceAll("${CLAUDE_PLUGIN_ROOT}", directory),
    );
    assert.ok(
      arguments_.every((value) => !value.includes("${")),
      "Unresolved plugin variable",
    );
    command = server.command;
    cwd =
      platform === "codex"
        ? resolve(directory, server.cwd ?? ".")
        : workingDirectory;
  }
  const client = new Client({
    name: "vibecheck-linear-jev-release-verifier",
    version: "1.0.0",
  });
  const configHome = await mkdtemp(
    join(tmpdir(), "vibecheck-linear-jev-config-"),
  );
  const transport = new StdioClientTransport({
    command,
    args: [...arguments_, "--database", database],
    cwd,
    env: {
      ...getDefaultEnvironment(),
      VIBECHECK_LINEAR_JEV_PROJECTS: "release-test",
      XDG_CONFIG_HOME: configHome,
      // The test-only Linear: a workspace in a JSON file, never the network.
      VIBECHECK_LINEAR_JEV_LINEAR_BACKEND: "memory",
      VIBECHECK_LINEAR_JEV_MEMORY_FILE: `${database}.linear.json`,
    },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    diagnostics += String(chunk);
  });
  const deadline = setTimeout(() => {
    void client.close();
  }, 30_000);
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, expectedVersion);
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), toolNames);
    for (const tool of listing.tools)
      assert.deepEqual(tool.inputSchema.required, ["request"]);
    async function call(
      name: string,
      request: Record<string, unknown>,
    ): Promise<unknown> {
      const result = await client.callTool({
        name,
        arguments: { request: { project_id: "release-test", ...request } },
      });
      assert.notEqual(
        result.isError,
        true,
        `${name}: ${JSON.stringify(result)}`,
      );
      return result.structuredContent;
    }
    const joined = z.object({ session_id: z.string() }).parse(
      await call("project_join", {
        request_id: "join",
        repository: "release-fixture",
        vendor: "verification",
        runtime: "bun",
        external_session_id: "release-session",
        model: "no-model-executed",
      }),
    );
    const session = { session_id: joined.session_id };
    const publishRequest = {
      ...session,
      request_id: "publish",
      expected_revision: 0,
      project: {
        name: "vc-test-release",
        summary: "Release lifecycle check.",
        icon: "Rocket",
        color: "#5e6ad2",
      },
      milestones: [{ name: "Release", description: "Everything." }],
      tasks: [
        {
          key: "implement",
          title: "Initial scope",
          goal: "Implement the initial scope of the release fixture",
          criteria: ["the fixture runs end to end"],
          milestone: "M1",
        },
      ],
    };
    // The fixture plan leaves fields empty, so the first publish is held
    // (ruling 12) and names its problems; accepting them by id publishes.
    const held = z
      .object({
        ready: z.literal(false),
        problems: z.array(z.object({ id: z.string() })).nonempty(),
      })
      .parse(await call("plan_publish", publishRequest));
    const published = z
      .object({
        plan_revision: z.number(),
        task_map: z.record(z.string(), z.object({ identifier: z.string() })),
        completeness: z.record(z.string(), z.unknown()),
      })
      .parse(
        await call("plan_publish", {
          ...publishRequest,
          accept: held.problems.map((problem) => problem.id),
        }),
      );
    const identifier = published.task_map["implement"]?.identifier;
    assert.ok(identifier !== undefined, "publish mapped the task to an issue");
    const plan = z
      .object({ plan_revision: z.number() })
      .parse(await call("plan_read", {}));
    assert.equal(plan.plan_revision, 1);
    await call("plan_ack", {
      ...session,
      request_id: "ack",
      plan_revision: plan.plan_revision,
    });
    await call("plan_edit", {
      ...session,
      request_id: "edit",
      expected_revision: plan.plan_revision,
      operations: [
        { op: "update_task", task_id: "implement", title: "Released scope" },
      ],
    });
    await call("issue_adopt", {
      ...session,
      request_id: "adopt",
      issue: identifier,
      key: "implement",
    });
    const claimed = z.object({ work: z.object({ id: z.string() }) }).parse(
      await call("work_claim", {
        ...session,
        request_id: "claim",
        task_id: "implement",
        location: { branch: "release/topic", paths: ["src/example.ts"] },
      }),
    );
    await call("work_update", {
      ...session,
      request_id: "complete",
      updates: [
        {
          work_id: claimed.work.id,
          status: "complete",
          report: "The fixture runs end to end.",
        },
      ],
    });
    const status = z
      .object({ tasks: z.record(z.string(), z.object({ status: z.string() })) })
      .parse(await call("project_status", { full: true }));
    assert.equal(status.tasks["implement"]?.status, "complete");
    const history = z
      .object({ work: z.array(z.object({ id: z.string() })) })
      .parse(await call("work_history", { task_id: "implement" }));
    assert.ok(history.work.some((work) => work.id === claimed.work.id));
    await call("project_update", {
      ...session,
      request_id: "update",
      body: "Release fixture complete.",
    });
    const forbidden = await client.callTool({
      name: "project_status",
      arguments: { request: { project_id: "unlisted" } },
    });
    assert.equal(forbidden.isError, true);
  } catch (error) {
    throw new Error(`${platform} at ${directory}: ${diagnostics}`, {
      cause: error,
    });
  } finally {
    clearTimeout(deadline);
    await client.close();
    await rm(configHome, { recursive: true, force: true });
  }
  await exerciseHooks(directory, platform, database);
}

/**
 * The command a harness runs for one of its hooks, read from that harness's
 * own hook configuration, with the plugin root filled in the way the harness
 * fills it: Claude Code and Codex substitute a variable, Muse resolves the
 * script against the plugin folder, and Antigravity runs in the plugin folder.
 */
export async function hookCommand(
  directory: string,
  platform: Platform,
  name: string,
): Promise<{ argv: string[]; cwd: string }> {
  if (platform === "muse") {
    const id = name === "stop" ? "subagent-stop" : name;
    const manifest = museManifestSchema.parse(
      await json(join(directory, ".muse-plugin/plugin.json")),
    );
    const entry = manifest.capabilities.hooks.find((hook) => hook.id === id);
    const [command, script, ...rest] = entry?.command ?? [];
    assert.ok(
      command !== undefined && script !== undefined,
      `muse has no ${id} hook`,
    );
    return {
      argv: [command, resolve(directory, script), ...rest],
      cwd: tmpdir(),
    };
  }
  if (platform === "antigravity") {
    const hooks = antigravityHooksSchema.parse(
      await json(join(directory, "hooks.json")),
    )[PRODUCT];
    const handler =
      name === "pretool"
        ? hooks.PreToolUse[0].hooks[0]
        : name === "bash-guard"
          ? hooks.PreToolUse[1].hooks[0]
          : hooks.Stop[0];
    return { argv: handler.command.split(" "), cwd: directory };
  }
  const hooksPath = hookFile(platform);
  assert.ok(hooksPath !== undefined);
  const hooks = hooksSchema.parse(await json(join(directory, hooksPath)));
  const command = Object.values(hooks.hooks)
    .flat()
    .flatMap((group) => group.hooks.map((hook) => hook.command))
    .find((entry) => entry.endsWith(` hook ${name} --client ${platform}`));
  const parsed = /^(?<command>\S+) "(?<script>[^"]+)" (?<rest>.+)$/u.exec(
    command ?? "",
  )?.groups;
  assert.ok(
    parsed?.["command"] !== undefined &&
      parsed["script"] !== undefined &&
      parsed["rest"] !== undefined,
    `${platform} has no ${name} hook`,
  );
  const variable =
    platform === "codex" ? "$PLUGIN_ROOT" : "${CLAUDE_PLUGIN_ROOT}";
  return {
    argv: [
      parsed["command"],
      parsed["script"].replaceAll(variable, directory),
      ...parsed["rest"].split(" "),
    ],
    cwd: tmpdir(),
  };
}

/**
 * Runs each hook as the harness's hook configuration states it, with a
 * client payload. The delete guard must refuse an unguarded delete; with no
 * judgment source configured the Stop checks must fail open.
 */
export async function exerciseHooks(
  directory: string,
  platform: Platform,
  database: string,
): Promise<void> {
  const environment = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    VIBECHECK_LINEAR_JEV_DB: database,
    XDG_CONFIG_HOME: join(
      tmpdir(),
      `vibecheck-linear-jev-hook-config-${process.pid}-${platform}`,
    ),
    XDG_DATA_HOME: join(
      tmpdir(),
      `vibecheck-linear-jev-hook-data-${process.pid}-${platform}`,
    ),
  };
  try {
    const commands = new Map<string, { argv: string[]; cwd: string }>();
    for (const name of ["bash-guard", "stop", "session-end"])
      if (name !== "session-end" || platform === "muse")
        commands.set(name, await hookCommand(directory, platform, name));
    const common = {
      session_id: "release-hook-session",
      cwd: tmpdir(),
      transcript_path: null,
      ...(platform === "claude"
        ? {}
        : {
            turn_id: "release-turn",
            model: "release-model",
            permission_mode: "default",
            ...(platform === "muse" ? { model_provider: "meta" } : {}),
          }),
    };
    const hook = (name: string, payload: object) => {
      const command = commands.get(name);
      assert.ok(command !== undefined, `${platform} ${name} hook`);
      const [executable, ...arguments_] = command.argv;
      assert.ok(executable !== undefined);
      return spawnSync(executable, arguments_, {
        cwd: command.cwd,
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: environment,
        timeout: 30_000,
      });
    };
    if (platform === "antigravity") {
      const conversation = {
        conversationId: "release-hook-session",
        workspacePaths: [tmpdir()],
      };
      const guarded = hook("bash-guard", {
        ...conversation,
        stepIdx: 1,
        toolCall: {
          name: "run_command",
          args: { CommandLine: 'rm -rf "$TARGET/build"' },
        },
      });
      assert.equal(guarded.status, 0, guarded.stderr);
      assert.match(guarded.stdout, /"decision":"deny"/u);
      const allowed = hook("bash-guard", {
        ...conversation,
        stepIdx: 2,
        toolCall: {
          name: "run_command",
          args: { CommandLine: 'rm -rf "${TARGET:?}/build"' },
        },
      });
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.match(allowed.stdout, /"decision":"allow"/u);
      const stop = hook("stop", {
        ...conversation,
        executionNum: 1,
        terminationReason: "NO_TOOL_CALL",
        fullyIdle: true,
      });
      assert.equal(stop.status, 0, stop.stderr);
      assert.doesNotMatch(stop.stdout, /"decision":"continue"/u);
      return;
    }
    const guarded = hook("bash-guard", {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'rm -rf "$TARGET/build"' },
    });
    assert.equal(guarded.status, 0, guarded.stderr);
    assert.match(guarded.stdout, /"permissionDecision":"deny"/u);
    const allowed = hook("bash-guard", {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'rm -rf "${TARGET:?}/build"' },
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, "");
    const stop = hook(
      "stop",
      platform === "muse"
        ? {
            ...common,
            hook_event_name: "SubagentStop",
            stop_hook_active: false,
            last_assistant_message: "Done.",
            child_session_id: "release-hook-session",
            subagent_id: "release-subagent",
          }
        : {
            ...common,
            hook_event_name: "Stop",
            stop_hook_active: false,
            last_assistant_message: "Done.",
          },
    );
    assert.notEqual(stop.status, 2, stop.stderr);
    assert.doesNotMatch(stop.stdout, /"decision":"block"/u);
    if (platform === "muse") {
      const ended = hook("session-end", {
        session_id: "release-hook-session",
        cwd: tmpdir(),
        transcript_path: null,
        hook_event_name: "SessionEnd",
        model: "release-model",
        model_provider: "meta",
        permission_mode: "default",
        reason: "other",
      });
      assert.notEqual(ended.status, 2, ended.stderr);
      assert.doesNotMatch(ended.stdout, /"decision":"block"/u);
    }
  } finally {
    rmSync(environment.XDG_CONFIG_HOME, { recursive: true, force: true });
    rmSync(environment.XDG_DATA_HOME, { recursive: true, force: true });
  }
}

function inventory(output: string, expected: string[]): void {
  const entries = output.trim().split("\n");
  assert.equal(
    new Set(entries).size,
    entries.length,
    "Duplicate archive entries",
  );
  const files = expected.map((file) => `${PRODUCT}/${file}`);
  for (const entry of entries) {
    const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    assert.ok(
      (name === PRODUCT || name.startsWith(`${PRODUCT}/`)) &&
        !name.includes("\\") &&
        name
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
      `Unsafe archive entry ${entry}`,
    );
    if (entry.endsWith("/"))
      assert.ok(
        files.some((file) => file.startsWith(entry)),
        `Unexpected archive directory ${entry}`,
      );
  }
  assert.deepEqual(
    entries.filter((entry) => !entry.endsWith("/")).sort(),
    files.sort(),
  );
}

async function makeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeReadOnly(path);
    else await chmod(path, 0o444);
  }
  await chmod(directory, 0o555);
}

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
  }
}

async function compareFiles(
  directory: string,
  files: string[],
  context = "Archive bytes differ",
): Promise<void> {
  for (const file of files) {
    const target = join(directory, file);
    assert.ok((await lstat(target)).isFile(), `${file} is not a regular file`);
    assert.deepEqual(
      await readFile(target),
      await readFile(join(root, file)),
      `${context}: ${file}`,
    );
  }
}

export async function verifyNativeInstall(
  directory: string,
  platform: Platform,
  temporary: string,
): Promise<void> {
  // No Antigravity harness runs in the sandbox; the install is verified by
  // hand against the agy CLI instead.
  if (platform === "antigravity") return;
  const sandbox = join(temporary, `${platform}-native`);
  await mkdir(sandbox, { recursive: true });
  const arguments_ = [
    "--die-with-parent",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    temporary,
    temporary,
  ];
  for (const name of [".codex", ".agents", ".claude", ".cache"]) {
    const isolated = join(sandbox, name);
    await mkdir(isolated, { recursive: true });
    arguments_.push("--bind", isolated, join(homedir(), name));
  }
  for (const relative of [".local/share/muse", ".config/muse"]) {
    const isolated = join(sandbox, relative);
    await mkdir(isolated, { recursive: true });
    if (relative === ".local/share/muse") {
      // Muse disables plugins without its feature and model caches, which
      // it cannot fetch inside the sandbox, so seed them. No plugin state
      // comes along: the install starts from an empty store.
      for (const seed of ["feature-config", "model-catalog"]) {
        try {
          await cp(join(homedir(), relative, seed), join(isolated, seed), {
            recursive: true,
          });
        } catch {
          // a fresh machine has no cache to seed
        }
      }
    }
    arguments_.push("--bind", isolated, join(homedir(), relative));
  }
  const userFile = join(sandbox, ".claude.json");
  await writeFile(userFile, "{}\n");
  arguments_.push(
    "--bind",
    userFile,
    join(homedir(), ".claude.json"),
    "--chdir",
    temporary,
  );
  let cached: string;
  let installedVersion: string;
  if (platform === "muse") {
    // Muse refuses directories with symlinks, so the native install runs
    // from a clean staging of the shipped files, like an extracted archive.
    const staged = join(temporary, "muse-native-source");
    await mkdir(staged, { recursive: true });
    for (const file of pluginFiles("muse")) {
      const target = join(staged, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(directory, file), target);
    }
    run("bwrap", [...arguments_, "muse", "plugins", "validate", staged]);
    run("bwrap", [...arguments_, "muse", "plugins", "install", staged]);
    const listing = z
      .object({
        plugins: z.array(
          z.object({
            plugin: z.object({
              capabilities: z.object({
                hooks: z.array(z.object({ source_path: z.string() })),
              }),
            }),
          }),
        ),
      })
      .parse(
        JSON.parse(
          run("bwrap", [...arguments_, "muse", "plugins", "list", "--json"]),
        ),
      );
    const hookPath = listing.plugins
      .at(0)
      ?.plugin.capabilities.hooks.at(0)?.source_path;
    assert.ok(hookPath !== undefined);
    const packaged = dirname(dirname(hookPath));
    const home = homedir();
    assert.ok(packaged.startsWith(`${home}/`));
    cached = join(sandbox, packaged.slice(home.length + 1));
    installedVersion = museManifestSchema.parse(
      await json(join(staged, ".muse-plugin/plugin.json")),
    ).version;
  } else {
    if (platform === "codex") {
      run("bwrap", [
        ...arguments_,
        "codex",
        "plugin",
        "marketplace",
        "add",
        directory,
      ]);
      run("bwrap", [
        ...arguments_,
        "codex",
        "plugin",
        "add",
        `${PRODUCT}@${PRODUCT}`,
      ]);
      assert.match(
        run("bwrap", [...arguments_, "codex", "plugin", "list"]),
        /vibecheck-linear-jev/u,
      );
    } else {
      run("bwrap", [...arguments_, "claude", "plugin", "validate", directory]);
      run("bwrap", [
        ...arguments_,
        "claude",
        "plugin",
        "marketplace",
        "add",
        directory,
      ]);
      run("bwrap", [
        ...arguments_,
        "claude",
        "plugin",
        "install",
        `${PRODUCT}@${PRODUCT}`,
      ]);
      assert.match(
        run("bwrap", [...arguments_, "claude", "plugin", "list"]),
        /vibecheck-linear-jev/u,
      );
    }
    const manifest = manifestSchema.parse(
      await json(join(directory, `.${platform}-plugin/plugin.json`)),
    );
    installedVersion = manifest.version;
    cached = join(
      sandbox,
      platform === "codex" ? ".codex" : ".claude",
      `plugins/cache/${PRODUCT}/${PRODUCT}`,
      manifest.version,
    );
  }
  await rm(join(cached, "node_modules"), { recursive: true, force: true });
  await makeReadOnly(cached);
  try {
    await exercisePlugin(
      cached,
      platform,
      join(temporary, "cached.sqlite3"),
      temporary,
      installedVersion,
    );
  } finally {
    await makeWritable(cached);
  }
}

export async function verifyRelease(
  outputDirectory = join(root, "artifacts"),
  native = false,
): Promise<void> {
  const version = await verifyVersions(root);
  assert.equal(
    sha256(await readFile(join(root, BUNDLE))),
    sha256(await generateBundle()),
    "Committed runtime is stale; run bun run build:release",
  );
  assert.equal(
    await readFile(join(root, "runtime/THIRD-PARTY-NOTICES.txt"), "utf8"),
    await generateNotices(),
    "Bundled dependency notices are stale; run bun run build:release",
  );
  const lines = (await readFile(join(outputDirectory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  const checksums = lines.map((line) => {
    const parts = /^(?<digest>[0-9a-f]{64})  (?<name>[A-Za-z0-9_.-]+)$/u.exec(
      line,
    )?.groups;
    return z.object({ digest: z.string(), name: z.string() }).parse(parts);
  });
  assert.deepEqual(
    checksums.map((entry) => entry.name).sort(),
    artifactNames(version),
  );
  for (const entry of checksums)
    assert.equal(
      sha256(await readFile(join(outputDirectory, entry.name))),
      entry.digest,
      entry.name,
    );
  const temporary = await mkdtemp(
    join(tmpdir(), "vibecheck-linear-jev release spaces "),
  );
  const readOnly: string[] = [];
  try {
    for (const platform of platforms) {
      const archive = join(
        outputDirectory,
        `${PRODUCT}-${platform}-plugin-${version}.zip`,
      );
      const files = pluginFiles(platform);
      inventory(run("unzip", ["-Z1", archive]), files);
      const rows = run("unzip", ["-Z", "-l", archive])
        .split("\n")
        .filter((line) => /^[bcdlps-][rwxstST-]{9} /u.test(line));
      assert.equal(
        rows.length,
        files.length,
        "ZIP entry metadata is incomplete",
      );
      for (const row of rows) {
        assert.equal(
          row.slice(0, 10),
          "-rw-r--r--",
          "Unexpected ZIP entry type or permissions",
        );
        assert.ok(
          row.includes("00-Jan-01 00:00"),
          "ZIP timestamp differs from the release epoch",
        );
      }
      const extracted = join(temporary, platform);
      await mkdir(extracted);
      run("unzip", ["-q", archive, "-d", extracted]);
      const plugin = join(extracted, PRODUCT);
      await compareFiles(plugin, files);
      await compareFiles(
        join(root, platformDir(platform)),
        files,
        "Platform bytes differ",
      );
      await makeReadOnly(plugin);
      readOnly.push(plugin);
      await exercisePlugin(
        root,
        platform,
        join(temporary, `${platform}-source.db`),
        temporary,
        version,
      );
      await exercisePlugin(
        join(root, platformDir(platform)),
        platform,
        join(temporary, `${platform}-unit.db`),
        temporary,
        version,
      );
      await exercisePlugin(
        plugin,
        platform,
        join(temporary, `${platform}-archive.db`),
        temporary,
        version,
      );
      if (native) {
        await verifyNativeInstall(
          root,
          platform,
          join(temporary, `${platform}-source-install`),
        );
        await verifyNativeInstall(
          plugin,
          platform,
          join(temporary, `${platform}-archive-install`),
        );
      }
    }
    const archive = join(
      outputDirectory,
      `${PRODUCT}-runtime-${version}.tar.gz`,
    );
    inventory(run("tar", ["-tzf", archive]), commonFiles);
    for (const row of run("tar", ["-tvzf", archive]).trim().split("\n"))
      assert.match(
        row,
        /^[-d][rwx-]{9} /u,
        "Tar contains a link or special file",
      );
    const extracted = join(temporary, "standalone");
    await mkdir(extracted);
    run("tar", ["-xzf", archive, "-C", extracted]);
    const runtimeRoot = join(extracted, PRODUCT);
    await compareFiles(runtimeRoot, commonFiles);
    await makeReadOnly(runtimeRoot);
    readOnly.push(runtimeRoot);
    assert.equal(
      run("bun", [join(runtimeRoot, BUNDLE), "--version"], temporary).trim(),
      `${PRODUCT} ${version}`,
    );
  } finally {
    for (const directory of readOnly) await makeWritable(directory);
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arguments_ = process.argv.slice(2);
  assert.ok(
    arguments_.every((argument) => argument === "--native"),
    "Usage: bun scripts/verify-release.ts [--native]",
  );
  await verifyRelease(undefined, arguments_.includes("--native"));
  process.stdout.write(
    "Verified release checksums, bundled bytes, hook files, and source and extracted plugin MCP lifecycles and hooks under Bun.\n",
  );
}
