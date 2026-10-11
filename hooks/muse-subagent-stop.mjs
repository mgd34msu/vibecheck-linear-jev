// Muse SubagentStop hook: sends a subagent back to work when its final reply
// puts required work off, claims done while its claims show work left, or
// states as fact what the turn's tool output does not show. Muse refuses two
// hooks that share a source file, so each Muse hook has its own file.
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
  [process.execPath, runtime, "hook", "stop", "--client", "muse"],
  { stdio: ["inherit", "inherit", "inherit"] },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
