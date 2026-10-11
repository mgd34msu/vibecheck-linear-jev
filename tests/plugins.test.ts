import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  BUNDLE,
  hookFile,
  packageVersion,
  platforms,
  pluginFiles,
} from "../scripts/build-release.js";
import { exercisePlugin, verifyVersions } from "../scripts/verify-release.js";

const checkout = resolve(process.cwd());

test("native manifests agree with the package version and repository catalogs", async () => {
  assert.equal(await verifyVersions(checkout), await packageVersion(checkout));
});

test("no shipped file or command goes through bash or Node.js", async () => {
  for (const platform of platforms) {
    const files = pluginFiles(platform);
    assert.ok(
      files.every((file) => !file.endsWith(".sh")),
      `${platform} ships a shell script`,
    );
    const configs = files.filter(
      (file) =>
        file.endsWith(".json") &&
        (file === hookFile(platform) ||
          /^\.[a-z]+-plugin\/plugin\.json$/u.test(file) ||
          file === "mcp_config.json" ||
          file === "hooks.json"),
    );
    for (const file of configs) {
      const text = readFileSync(join(checkout, file), "utf8");
      assert.doesNotMatch(text, /"bash"|"node"|\bbash |\bnode /u, file);
      assert.match(text, /\bbun\b/u, file);
    }
  }
});

for (const platform of platforms) {
  test(
    `${platform} plugin runs its eleven-tool lifecycle with bun on the memory Linear from a read-only path containing spaces`,
    { timeout: 40_000 },
    async (context) => {
      const temporary = await mkdtemp(
        join(tmpdir(), "vibecheck-linear-jev plugin test "),
      );
      const plugin = join(temporary, "read only plugin");
      const directories = new Set<string>([plugin]);
      context.after(async () => {
        for (const directory of [...directories].sort(
          (left, right) => left.length - right.length,
        ))
          await chmod(directory, 0o755);
        await rm(temporary, { recursive: true, force: true });
      });
      for (const file of pluginFiles(platform)) {
        const target = join(plugin, file);
        await mkdir(dirname(target), { recursive: true });
        await cp(join(checkout, file), target);
        await chmod(target, 0o444);
        let directory = dirname(target);
        while (directory.startsWith(`${plugin}/`)) {
          directories.add(directory);
          directory = dirname(directory);
        }
      }
      for (const directory of [...directories].sort(
        (left, right) => right.length - left.length,
      ))
        await chmod(directory, 0o555);
      const version = await packageVersion(checkout);
      const launched = spawnSync("bun", [join(plugin, BUNDLE), "--version"], {
        cwd: temporary,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(launched.status, 0, launched.stderr);
      assert.equal(launched.stdout, `vibecheck-linear-jev ${version}\n`);
      await exercisePlugin(
        plugin,
        platform,
        join(temporary, "external database.sqlite3"),
        temporary,
        version,
      );
    },
  );
}
