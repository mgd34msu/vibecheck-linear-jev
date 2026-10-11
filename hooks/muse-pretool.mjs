// Muse PreToolUse hook for agent briefs. Muse sends every tool call to every
// PreToolUse hook, so the hook itself keeps only subagent briefs. Muse refuses
// two hooks that share a source file, so each Muse hook has its own file.
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
  [process.execPath, runtime, "hook", "pretool", "--client", "muse"],
  { stdio: ["inherit", "inherit", "inherit"] },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
