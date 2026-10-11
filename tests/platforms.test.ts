import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import {
  ANTIGRAVITY_HOOKS,
  MUSE_HOOKS,
  platformDir,
  platforms,
  pluginFiles,
  type Platform,
} from "../scripts/build-release.js";

const checkout = resolve(process.cwd());

function inventory(unit: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), `${path} is a symlink`);
      if (stat.isDirectory()) walk(path);
      else files.push(relative(unit, path).split(sep).join("/"));
    }
  };
  walk(unit);
  return files.sort();
}

function matches(path: string, entry: string): boolean {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

/** Marketplace catalogs resolve the install; they never ship inside one. */
const CATALOGS = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];

/** The dev tree stays out of every install unit. */
const DEV_ONLY = ["node_modules/", ".git/", "src/", "tests/"];

const FOREIGN_MANIFESTS: Record<Platform, readonly string[]> = {
  codex: [
    ".claude-plugin/",
    ".muse-plugin/",
    "plugin.json",
    "mcp_config.json",
    "hooks.json",
  ],
  claude: [
    ".codex-plugin/",
    ".agents/",
    ".muse-plugin/",
    "plugin.json",
    "mcp_config.json",
    "hooks.json",
  ],
  muse: [
    ".claude-plugin/",
    ".codex-plugin/",
    ".agents/",
    "plugin.json",
    "mcp_config.json",
    "hooks.json",
  ],
  antigravity: [
    ".claude-plugin/",
    ".codex-plugin/",
    ".agents/",
    ".muse-plugin/",
  ],
};

const FOREIGN_HOOKS: Record<Platform, readonly string[]> = {
  codex: ["hooks/hooks.json", ...MUSE_HOOKS, ...ANTIGRAVITY_HOOKS],
  claude: ["hooks/codex-hooks.json", ...MUSE_HOOKS, ...ANTIGRAVITY_HOOKS],
  muse: ["hooks/hooks.json", "hooks/codex-hooks.json", ...ANTIGRAVITY_HOOKS],
  antigravity: ["hooks/hooks.json", "hooks/codex-hooks.json", ...MUSE_HOOKS],
};

for (const platform of platforms) {
  test(`${platform} install unit holds exactly its files`, () => {
    const unit = join(checkout, platformDir(platform));
    const files = inventory(unit);
    assert.deepEqual(files, [...pluginFiles(platform)].sort());
    for (const file of files)
      assert.deepEqual(
        readFileSync(join(unit, file)),
        readFileSync(join(checkout, file)),
        `${platformDir(platform)}/${file} differs from the source`,
      );
  });

  test(`${platform} install unit carries no foreign harness files`, () => {
    const files = inventory(join(checkout, platformDir(platform)));
    const forbidden = [
      ...CATALOGS,
      ...DEV_ONLY,
      ...FOREIGN_MANIFESTS[platform],
      ...FOREIGN_HOOKS[platform],
    ];
    for (const path of files)
      for (const entry of forbidden)
        assert.ok(
          !matches(path, entry),
          `${platformDir(platform)}/${path} is foreign: ${entry}`,
        );
  });
}
