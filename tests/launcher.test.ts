import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BUNDLE, packageVersion } from "../scripts/build-release.js";

const checkout = resolve(process.cwd());
const posix = process.platform !== "win32";
const KEY = "vclj-launcher-key-93be01";

/**
 * A config folder whose only judgment source is hosted Jev at a closed local
 * port, so `sources` shows whether a key was found without any network call:
 * with a key it reports the port does not answer, without one it reports the
 * missing key.
 */
async function sandbox(): Promise<{
  directory: string;
  env: Record<string, string>;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "vibecheck-linear-jev-launcher-"),
  );
  await mkdir(join(directory, "config", "vibecheck-linear-jev"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "config", "vibecheck-linear-jev", "config.jsonc"),
    JSON.stringify({
      sources: [{ id: "jev", kind: "typesafe", baseURL: "http://127.0.0.1:9" }],
    }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== "TYPESAFE_API_KEY") env[key] = value;
  env["HOME"] = directory;
  env["XDG_CONFIG_HOME"] = join(directory, "config");
  env["XDG_DATA_HOME"] = join(directory, "data");
  return { directory, env };
}

async function shell(directory: string, body: string): Promise<string> {
  const path = join(directory, "fake-shell");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

function runtime(arguments_: string[], env: Record<string, string>) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [join(checkout, BUNDLE), ...arguments_],
    { encoding: "utf8", env, timeout: 30_000, input: "" },
  );
  return { ...result, elapsed: Date.now() - started };
}

test("the runtime answers --version without reading the shell", async () => {
  const { directory, env } = await sandbox();
  try {
    env["SHELL"] = await shell(directory, "sleep 60");
    const result = runtime(["--version"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `vibecheck-linear-jev ${await packageVersion(checkout)}\n`,
    );
    assert.ok(result.elapsed < 3_000, `--version took ${result.elapsed} ms`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "the runtime takes TYPESAFE_API_KEY from the interactive shell when the client omits it",
  { skip: !posix, timeout: 60_000 },
  async () => {
    const { directory, env } = await sandbox();
    try {
      env["SHELL"] = await shell(
        directory,
        `echo "rc noise"\nexport TYPESAFE_API_KEY=${KEY}\nexec /bin/sh -c "$2"`,
      );
      const found = runtime(["sources"], env);
      assert.match(
        found.stdout,
        /jev \(typesafe\) at http:\/\/127\.0\.0\.1:9: does not answer/u,
      );
      assert.ok(!found.stdout.includes(KEY) && !found.stderr.includes(KEY));

      env["SHELL"] = await shell(directory, 'exec /bin/sh -c "$2"');
      const missing = runtime(["sources"], env);
      assert.match(missing.stdout, /jev \(typesafe\): not usable: no API key/u);
      assert.equal(missing.stderr, "");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "the runtime reads a source's key from its key file, then from the shell for a named variable",
  { skip: !posix, timeout: 60_000 },
  async () => {
    const { directory, env } = await sandbox();
    try {
      const configPath = join(
        directory,
        "config",
        "vibecheck-linear-jev",
        "config.jsonc",
      );
      const keyFile = join(directory, "typesafe.key");
      await writeFile(keyFile, `${KEY}\n`, { mode: 0o600 });
      await writeFile(
        configPath,
        JSON.stringify({
          sources: [
            {
              id: "jev",
              kind: "typesafe",
              baseURL: "http://127.0.0.1:9",
              auth: { apiKeyFile: keyFile },
            },
          ],
        }),
      );
      env["SHELL"] = await shell(directory, 'exec /bin/sh -c "$2"');
      const fromFile = runtime(["sources"], env);
      assert.match(fromFile.stdout, /jev \(typesafe\).*does not answer/u);
      assert.ok(!fromFile.stdout.includes(KEY));
      assert.ok(!fromFile.stderr.includes(KEY));

      await writeFile(
        configPath,
        JSON.stringify({
          sources: [
            {
              id: "jev",
              kind: "typesafe",
              baseURL: "http://127.0.0.1:9",
              auth: { apiKeyEnv: "VCLJ_CUSTOM_JEV_KEY" },
            },
          ],
        }),
      );
      env["SHELL"] = await shell(
        directory,
        `export VCLJ_CUSTOM_JEV_KEY=${KEY}\nexec /bin/sh -c "$2"`,
      );
      const fromShell = runtime(["sources"], env);
      assert.match(fromShell.stdout, /jev \(typesafe\).*does not answer/u);
      assert.ok(!fromShell.stdout.includes(KEY));

      env["SHELL"] = await shell(directory, 'exec /bin/sh -c "$2"');
      const missing = runtime(["sources"], env);
      assert.match(missing.stdout, /VCLJ_CUSTOM_JEV_KEY is not set/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a hook finishes when the interactive shell hangs",
  { skip: !posix, timeout: 60_000 },
  async () => {
    const { directory, env } = await sandbox();
    try {
      env["SHELL"] = await shell(directory, "sleep 60 &\nsleep 60");
      env["VIBECHECK_LINEAR_JEV_DB"] = join(directory, "ledger.sqlite3");
      const started = Date.now();
      const result = spawnSync(
        process.execPath,
        [join(checkout, BUNDLE), "hook", "bash-guard", "--client", "claude"],
        {
          encoding: "utf8",
          env,
          timeout: 30_000,
          input: JSON.stringify({
            session_id: "launcher-hang",
            cwd: directory,
            transcript_path: null,
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: 'rm -rf "$TARGET/build"' },
          }),
        },
      );
      const elapsed = Date.now() - started;
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"permissionDecision":"deny"/u);
      assert.match(
        result.stderr,
        /no TYPESAFE_API_KEY from the interactive shell .*timed out after 5000 ms.*continuing without it/u,
      );
      assert.ok(elapsed < 15_000, `the hook waited ${elapsed} ms on the shell`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

/** The CLI from source (not the bundle), in a sandbox with no Linear key and a shell that exports nothing. */
async function cliSandbox(): Promise<{
  directory: string;
  run: (arguments_: string[]) => ReturnType<typeof spawnSync>;
}> {
  const { directory, env } = await sandbox();
  for (const key of Object.keys(env))
    if (key.startsWith("VIBECHECK_LINEAR_JEV_") || key === "LINEAR_API_KEY")
      delete env[key];
  env["SHELL"] = await shell(directory, "exit 0");
  env["VIBECHECK_LINEAR_JEV_DB"] = join(directory, "ledger.sqlite3");
  return {
    directory,
    run: (arguments_) =>
      spawnSync(
        process.execPath,
        [join(checkout, "src", "cli.ts"), ...arguments_],
        { encoding: "utf8", env, timeout: 60_000, input: "" },
      ),
  };
}

test(
  "check exits 1 when the check could not run: no usable source, unreadable input",
  { skip: !posix, timeout: 120_000 },
  async () => {
    const { directory, run } = await cliSandbox();
    try {
      const input = join(directory, "input.txt");
      await writeFile(input, "Ship the export.\n");
      const noSource = run(["check", "message", input, input]);
      assert.equal(noSource.status, 1, String(noSource.stderr));
      assert.match(String(noSource.stderr), /no judgment source is usable/u);
      assert.doesNotMatch(String(noSource.stderr), /usage:/u);
      const unreadable = run([
        "check",
        "message",
        join(directory, "missing-a.txt"),
        join(directory, "missing-b.txt"),
      ]);
      assert.equal(unreadable.status, 1, String(unreadable.stderr));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("check exits 2 only when it flagged its input and 0 when clean", async () => {
  const { checkCommand } = await import("../src/jev/tools/check.js");
  const { ScriptedProvider } = await import("../src/jev/lib/index.js");
  const directory = await mkdtemp(
    join(tmpdir(), "vibecheck-linear-jev-check-"),
  );
  try {
    const input = join(directory, "input.txt");
    await writeFile(input, "I will do the export later.\n");
    const code = (defers: number) =>
      checkCommand(["message", input, input], {
        out: () => undefined,
        err: () => undefined,
        env: { HOME: directory },
        config: {},
        judgment: {
          provider: new ScriptedProvider(() => defers),
          config: {},
          thresholdsFor: () => undefined,
          sources: [],
          unusable: [],
        },
      });
    assert.equal(await code(0.95), 2);
    assert.equal(await code(0.05), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "sync without a Linear key exits 1 and names where the key is looked up",
  { skip: !posix, timeout: 60_000 },
  async () => {
    const { directory, run } = await cliSandbox();
    try {
      const result = run(["sync"]);
      assert.equal(result.status, 1, String(result.stdout));
      assert.match(
        String(result.stderr),
        /sync: Linear is not available: no Linear API key found .*LINEAR_API_KEY \(linear\.apiKeyEnv\), then the file named by linear\.apiKeyFile in .*config\.jsonc, then your interactive shell's environment/u,
      );
      assert.doesNotMatch(String(result.stdout), /outbox:/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "every command refuses an unknown option with exit 1 and its usage",
  { skip: !posix, timeout: 300_000 },
  async () => {
    const { directory, run } = await cliSandbox();
    try {
      const cases: readonly (readonly [string[], RegExp])[] = [
        [["--bogus"], /Usage: vibecheck-linear-jev \[options\]/u],
        [["hook", "stop", "--bogus"], /usage:\n {2}hook pretool/u],
        [["check", "message", "--bogus"], /usage:\n {2}check brief/u],
        [["measure", "fixtures", "--bogus"], /usage:\n {2}measure fixtures/u],
        [["fixtures", "--bogus"], /usage:\n {2}fixtures/u],
        [["label", "list", "--bogus"], /usage:\n {2}label list/u],
        [["label", "mark", "abc", "right", "--bogus"], /usage:\n {2}label/u],
        [["watch-agents", "--bogus"], /usage:\n {2}watch-agents/u],
        [["exception-check", "--bogus"], /usage:\n {2}exception-check/u],
        [["report-of", "--bogus"], /usage:\n {2}report-of/u],
        [["sources", "--bogus"], /usage:\n {2}sources/u],
        [["config", "path", "--bogus"], /usage:\n {2}config path/u],
        [["config", "check", "--bogus"], /usage:\n {2}config path/u],
        [["config", "init", "--bogus"], /usage:\n {2}config path/u],
        [["laya", "install", "--bogus"], /usage:\n {2}laya install/u],
        [["laya", "serve", "--bogus"], /usage:\n {2}laya install/u],
        [["linear", "doctor", "--bogus"], /usage:\n {2}linear doctor/u],
        [["sync", "--bogus"], /usage:\n {2}sync/u],
      ];
      for (const [arguments_, usage] of cases) {
        const result = run(arguments_);
        const label = arguments_.join(" ");
        assert.equal(result.status, 1, `${label}: ${String(result.stderr)}`);
        assert.match(String(result.stderr), /'--bogus'/u, label);
        assert.match(String(result.stderr), usage, label);
        assert.doesNotMatch(String(result.stdout), /installing/u, label);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
