// sources [--source ID]
//   Probes each configured judgment source: it sends one small reading,
//   reports whether and how fast the source answers and which model did,
//   and lists the source's models where the server supports that.

import { noul } from "../lib/index.js";
import { sourcesOf } from "../config.js";
import { isJudgment, openJudgment, resolveSource } from "../judgment.js";
import { configOf, parse, type ToolIO } from "./common.js";

const PROBE = {
  state: "The build finished and every test passed.",
  questions: { passed: noul("Does the state say the tests passed?") },
};

export async function sourcesCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const { values } = parse(args, { source: { type: "string" } });
  const config = configOf(io);
  let failures = 0;
  const sources = sourcesOf(config).filter(
    (source) => values.source === undefined || source.id === values.source,
  );
  if (sources.length === 0) {
    io.err(`no configured source is named ${values.source ?? ""}`);
    return 1;
  }
  for (const source of sources) {
    const resolved = resolveSource(source, io.env);
    if (!resolved.ok) {
      failures += 1;
      io.out(`${source.id} (${source.kind}): not usable: ${resolved.reason}`);
      continue;
    }
    const judgment = openJudgment(config, {
      environment: io.env,
      onlySource: source.id,
      cached: false,
    });
    if (!isJudgment(judgment)) {
      failures += 1;
      io.out(`${source.id} (${source.kind}): not usable`);
      continue;
    }
    const started = performance.now();
    try {
      const evaluation = await judgment.provider.evaluate(PROBE);
      const answer = evaluation.answers["passed"];
      io.out(
        `${source.id} (${source.kind}) at ${resolved.source.baseURL}: answers in ${Math.round(performance.now() - started)} ms, model ${evaluation.model}${answer?.type === "noul" ? `, probe reading ${answer.noul.toFixed(2)} (expected high)` : ""}`,
      );
    } catch (error) {
      failures += 1;
      io.out(
        `${source.id} (${source.kind}) at ${resolved.source.baseURL}: does not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    try {
      const models = (await judgment.provider.listModels?.()) ?? [];
      io.out(
        models.length === 0
          ? "  models: none listed"
          : `  models: ${models.map((model) => model.name).join(", ")}`,
      );
    } catch {
      io.out("  models: this server does not list models");
    }
  }
  return failures === 0 ? 0 : 1;
}
