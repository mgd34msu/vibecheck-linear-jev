import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { platformDir, platforms, pluginFiles, root } from "./build-release.js";

for (const platform of platforms) {
  for (const file of pluginFiles(platform)) {
    assert.deepEqual(
      new Uint8Array(await readFile(join(root, platformDir(platform), file))),
      new Uint8Array(await readFile(join(root, file))),
      `${platformDir(platform)}/${file} is stale. Run bun run build:release.`,
    );
  }
}
process.stdout.write("Platform install units match the sources.\n");
