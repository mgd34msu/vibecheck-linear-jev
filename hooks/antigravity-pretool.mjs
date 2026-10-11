// Antigravity PreToolUse hook for agent briefs: checks subagent briefs and
// worker messages against the recorded plan. Antigravity runs each hook as a
// script path relative to the plugin folder, so each hook has its own file.
// It runs the bundled runtime under the Bun that runs this file, found from
// this file's own location so the working directory does not matter.
import { join } from "node:path";

const runtime = join(
  import.meta.dir,
  "..",
  "runtime",
  "vibecheck-linear-jev.mjs",
);
const child = Bun.spawn(
  [process.execPath, runtime, "hook", "pretool", "--client", "antigravity"],
  { stdio: ["inherit", "inherit", "inherit"] },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
