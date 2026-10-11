import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUNDLE,
  generateBundle,
  generateNotices,
  root,
} from "./build-release.js";

assert.deepEqual(
  new Uint8Array(await readFile(join(root, BUNDLE))),
  await generateBundle(),
  "Runtime bundle is stale. Run bun run build:release.",
);
assert.equal(
  await readFile(join(root, "runtime/THIRD-PARTY-NOTICES.txt"), "utf8"),
  await generateNotices(),
  "Bundled dependency notices are stale. Run bun run build:release.",
);
process.stdout.write(
  "Runtime bundle and dependency notices match the source.\n",
);
