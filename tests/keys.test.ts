import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { findKey, loadKey } from "../src/keys.js";

const KEY = "vclj-test-key-5d1c8a";
const NAME = "VCLJ_TEST_API_KEY";
const posix = process.platform !== "win32";
const keysModule = resolve(process.cwd(), "src/keys.ts");

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vibecheck-linear-jev-keys-"));
}

/** A stand-in for `$SHELL -ic COMMAND` that runs COMMAND after `setup`. */
async function fakeShell(directory: string, setup: string): Promise<string> {
  const path = join(directory, "fake-shell");
  await writeFile(path, `#!/bin/sh\n${setup}\nexec /bin/sh -c "$2"\n`);
  await chmod(path, 0o755);
  return path;
}

function environment(shell: string): Record<string, string | undefined> {
  return { PATH: process.env["PATH"], SHELL: shell };
}

test("the environment wins over the file and the shell", async () => {
  const directory = await scratch();
  try {
    const file = join(directory, "key");
    await writeFile(file, "from-file\n", { mode: 0o600 });
    const shell = await fakeShell(directory, `export ${NAME}=from-shell`);
    const found = await findKey({
      envName: NAME,
      file,
      env: { ...environment(shell), [NAME]: ` ${KEY} ` },
    });
    assert.deepEqual(found, { value: KEY, from: "env" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the key file is read when the environment has no key", async () => {
  const directory = await scratch();
  try {
    const file = join(directory, "key");
    await writeFile(file, `${KEY}\n`, { mode: 0o600 });
    const shell = await fakeShell(directory, `export ${NAME}=from-shell`);
    const found = await findKey({
      envName: NAME,
      file,
      env: { ...environment(shell), [NAME]: "" },
    });
    assert.deepEqual(found, { value: KEY, from: "file" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a missing key file falls through to the shell",
  { skip: !posix },
  async () => {
    const directory = await scratch();
    try {
      const shell = await fakeShell(directory, `export ${NAME}=${KEY}`);
      const found = await findKey({
        envName: NAME,
        file: join(directory, "absent"),
        env: environment(shell),
      });
      assert.deepEqual(found, { value: KEY, from: "shell" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "the shell's value is read between markers, ignoring what rc files print",
  { skip: !posix },
  async () => {
    const directory = await scratch();
    try {
      const shell = await fakeShell(
        directory,
        `echo "rc noise ${NAME}=decoy"\necho "more noise" >&2\nexport ${NAME}=${KEY}`,
      );
      for (let attempt = 0; attempt < 5; attempt += 1)
        assert.deepEqual(
          await findKey({ envName: NAME, env: environment(shell) }),
          { value: KEY, from: "shell" },
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a shell without the variable reports what was tried",
  { skip: !posix },
  async () => {
    const directory = await scratch();
    try {
      const shell = await fakeShell(directory, ":");
      const found = await findKey({
        envName: NAME,
        file: join(directory, "absent"),
        env: environment(shell),
      });
      assert.deepEqual(found, {
        value: undefined,
        tried: [
          `env ${NAME} (unset)`,
          `file ${join(directory, "absent")} (missing)`,
          `shell ${shell} (unset)`,
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a hanging shell is killed with its background jobs at the deadline",
  { skip: !posix, timeout: 20_000 },
  async () => {
    const directory = await scratch();
    try {
      const pidFile = join(directory, "background.pid");
      const shell = join(directory, "hanging-shell");
      await writeFile(
        shell,
        `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\nsleep 60\n`,
      );
      await chmod(shell, 0o755);
      const started = Date.now();
      const found = await findKey({
        envName: NAME,
        env: environment(shell),
        shellTimeoutMs: 500,
      });
      const elapsed = Date.now() - started;
      assert.deepEqual(found, {
        value: undefined,
        tried: [
          `env ${NAME} (unset)`,
          `shell ${shell} (timed out after 500 ms)`,
        ],
      });
      assert.ok(elapsed < 3_000, `the shell read took ${elapsed} ms`);
      const background = Number((await readFile(pidFile, "utf8")).trim());
      await Bun.sleep(200);
      assert.throws(
        () => process.kill(background, 0),
        "the shell's background job outlived the deadline",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("an invalid variable name is refused before any lookup", async () => {
  await assert.rejects(
    findKey({ envName: "NOT A NAME", env: { [NAME]: KEY } }),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes(KEY) &&
      /Not an environment variable name/u.test(error.message),
  );
});

test(
  "the key never appears in warnings, errors or what was tried",
  { skip: !posix, timeout: 20_000 },
  async () => {
    const directory = await scratch();
    try {
      const file = join(directory, "shared key");
      await writeFile(file, `${KEY}\n`, { mode: 0o644 });
      await chmod(file, 0o644);
      const failing = join(directory, "failing-shell");
      await writeFile(
        failing,
        `#!/bin/sh\nprintf '%s' "${KEY}"\necho "${KEY}"\necho "${KEY}" >&2\nexit 7\n`,
      );
      await chmod(failing, 0o755);
      const script = join(directory, "probe.ts");
      await writeFile(
        script,
        [
          `import { findKey, loadKey } from ${JSON.stringify(keysModule)};`,
          `const shared = await findKey({ envName: "${NAME}", file: ${JSON.stringify(file)}, env: { PATH: process.env.PATH } });`,
          `console.log(JSON.stringify({ from: shared.value === undefined ? undefined : shared.from }));`,
          `const failed = await findKey({ envName: "${NAME}", env: { PATH: process.env.PATH, SHELL: ${JSON.stringify(failing)} } });`,
          `console.log(JSON.stringify(failed));`,
          `process.env.SHELL = ${JSON.stringify(failing)};`,
          `await loadKey("${NAME}");`,
          `console.log(JSON.stringify({ loaded: process.env.${NAME} !== undefined }));`,
        ].join("\n"),
      );
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env))
        if (value !== undefined && key !== NAME) env[key] = value;
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env,
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes(KEY), result.stdout);
      assert.ok(!result.stderr.includes(KEY), result.stderr);
      const [shared, failed, loaded] = result.stdout.trim().split("\n");
      assert.equal(shared, JSON.stringify({ from: "file" }));
      assert.equal(
        failed,
        JSON.stringify({
          tried: [`env ${NAME} (unset)`, `shell ${failing} (exit 7)`],
        }),
      );
      assert.equal(loaded, JSON.stringify({ loaded: false }));
      assert.match(result.stderr, /can be read by other users/u);
      assert.match(
        result.stderr,
        new RegExp(`no ${NAME} from the interactive shell .*\\(exit 7\\)`, "u"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "loadKey sets the named variable from the key file before the shell",
  { skip: !posix },
  async () => {
    const directory = await scratch();
    try {
      const file = join(directory, "key");
      await writeFile(file, `${KEY}\n`, { mode: 0o600 });
      const env: Record<string, string | undefined> = {
        PATH: process.env["PATH"],
        SHELL: await fakeShell(directory, "exit 1"),
      };
      await loadKey(NAME, env, file);
      assert.equal(env[NAME], KEY);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
