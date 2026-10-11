// measure fixtures [--runs N] [--source ID] [--battery ID]
//   Uncached repeats of every fixture; the spread per question and the worst
//   margin to the fixture's bounds. FAIL is outside a bound, THIN within 0.10.
//   With --source, only that source answers, so the output says which
//   fixtures fail on it.
// measure live [--project ID]
//   Per check and source: readings, flags, and labeled flags right or wrong.
// measure replay [BATTERY-ID] [--project ID] [--source ID]
//   Re-reads every labeled verdict with the current battery and scores it
//   against its label: precision and recall, with each miss listed.
// fixtures [--source ID] [--battery ID]
//   One pass of every fixture; exits nonzero on any failure.

import {
  labelsByVerdict,
  queryEntries,
  type Entry,
  type VerdictEntry,
} from "../../verification/store.js";
import { BATTERIES, batteryById, type BatteryHandle } from "../registry.js";
import { settleMany } from "../lib/index.js";
import {
  fixed,
  judgmentOf,
  parse,
  projectOf,
  UsageError,
  withStore,
  type ToolIO,
} from "./common.js";

function selected(battery: string | undefined): readonly BatteryHandle[] {
  if (battery === undefined) return BATTERIES;
  const found = batteryById(battery);
  if (found === undefined) throw new UsageError(`unknown battery ${battery}`);
  return [found];
}

export async function fixturesCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const { values } = parse(args, {
    source: { type: "string" },
    battery: { type: "string" },
  });
  const judgment = judgmentOf(io, {
    cached: false,
    ...(values.source === undefined ? {} : { onlySource: values.source }),
  });
  let failed = 0;
  for (const battery of selected(values.battery)) {
    const report = await battery.runFixtures({
      provider: judgment.provider,
      thresholdsFor: judgment.thresholdsFor,
    });
    failed += report.failed;
    io.out(
      `${report.batteryId} v${report.batteryVersion}: ${report.passed} passed, ${report.failed} failed`,
    );
    for (const result of report.results)
      if (!result.passed)
        io.out(
          `  FAIL ${result.name}: ${result.failures.map((failure) => `${failure.questionId ?? "run"}: ${failure.message}`).join("; ")}`,
        );
  }
  return failed === 0 ? 0 : 1;
}

export async function measureCommand(
  args: string[],
  io: ToolIO,
): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "fixtures") return measureFixtures(rest, io);
  if (verb === "live") return measureLive(rest, io);
  if (verb === "replay") return measureReplay(rest, io);
  throw new UsageError("usage: measure fixtures|live|replay [options]");
}

async function measureFixtures(args: string[], io: ToolIO): Promise<number> {
  const { values } = parse(args, {
    runs: { type: "string", default: "5" },
    source: { type: "string" },
    battery: { type: "string" },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1)
    throw new UsageError("--runs must be a positive integer");
  const judgment = judgmentOf(io, {
    cached: false,
    ...(values.source === undefined ? {} : { onlySource: values.source }),
  });
  const rows: { worst: number; line: string; failing: string | undefined }[] =
    [];
  for (const battery of selected(values.battery)) {
    const samples = await battery.sample(runs, {
      provider: judgment.provider,
      thresholdsFor: judgment.thresholdsFor,
    });
    for (const sample of samples) {
      const flag =
        sample.worst < 0 ? "FAIL" : sample.worst < 0.1 ? "THIN" : "ok  ";
      rows.push({
        worst: sample.worst,
        line: `${flag} ${fixed(sample.worst).padStart(6)} spread ${fixed(sample.spread)}  ${battery.id} / ${sample.fixture} / ${sample.questionId}  [${sample.values.map((value) => fixed(value)).join(" ")}] via ${sample.sources.join(",") || "no source"}`,
        failing:
          sample.worst < 0
            ? `${battery.id} / ${sample.fixture} / ${sample.questionId}`
            : undefined,
      });
    }
  }
  rows.sort((left, right) => left.worst - right.worst);
  io.out(
    `worst margin first; THIN is under 0.10 from a bound; ${runs} uncached runs each${values.source === undefined ? "" : ` on source ${values.source}`}`,
  );
  for (const row of rows) io.out(row.line);
  const failing = rows.flatMap((row) =>
    row.failing === undefined ? [] : [row.failing],
  );
  io.out(
    failing.length === 0
      ? `no fixture fails${values.source === undefined ? "" : ` on ${values.source}`}: ${rows.length} readings checked`
      : `${failing.length} of ${rows.length} fixture readings fail${values.source === undefined ? "" : ` on ${values.source}`}:\n${failing.map((name) => `  ${name}`).join("\n")}`,
  );
  return failing.length === 0 ? 0 : 1;
}

async function verdictsAndLabels(
  io: ToolIO,
  project: string | undefined,
): Promise<Entry[]> {
  const projectId = projectOf(project);
  return withStore(io, (store) =>
    queryEntries(store.verificationAccess(), {
      ...(projectId === undefined ? {} : { projectId }),
      kinds: ["verdict", "label"],
      limit: 1_000_000,
    }),
  );
}

function stops(entry: VerdictEntry): boolean {
  return entry.body.outcome !== "passed";
}

async function measureLive(args: string[], io: ToolIO): Promise<number> {
  const { values } = parse(args, { project: { type: "string" } });
  const entries = await verdictsAndLabels(io, values.project);
  const labels = labelsByVerdict(entries);
  const groups = new Map<
    string,
    {
      readings: number;
      flags: number;
      flagRight: number;
      flagWrong: number;
      passRight: number;
      passWrong: number;
    }
  >();
  for (const entry of entries) {
    if (entry.kind !== "verdict" || entry.body.source.startsWith("test:"))
      continue;
    const key = `${entry.body.battery_id} ${entry.body.source} ${entry.body.judged_by?.source_id ?? "code"}`;
    const group = groups.get(key) ?? {
      readings: 0,
      flags: 0,
      flagRight: 0,
      flagWrong: 0,
      passRight: 0,
      passWrong: 0,
    };
    group.readings += 1;
    const flagged = stops(entry);
    if (flagged) group.flags += 1;
    const label = labels.get(entry.id);
    if (label !== undefined) {
      if (flagged && label.right) group.flagRight += 1;
      else if (flagged) group.flagWrong += 1;
      else if (label.right) group.passRight += 1;
      else group.passWrong += 1;
    }
    groups.set(key, group);
  }
  io.out(
    "check source judged-by: readings, flags, labeled flags right/wrong (precision), labeled passes right/wrong (misses)",
  );
  for (const [key, group] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const labeled = group.flagRight + group.flagWrong;
    io.out(
      `${key.padEnd(56)} ${String(group.readings).padStart(5)} ${String(group.flags).padStart(4)}   ${group.flagRight}/${group.flagWrong} (${labeled === 0 ? "n/a" : fixed(group.flagRight / labeled)})   ${group.passRight}/${group.passWrong}`,
    );
  }
  return 0;
}

async function measureReplay(args: string[], io: ToolIO): Promise<number> {
  const { values, positionals } = parse(args, {
    project: { type: "string" },
    source: { type: "string" },
  });
  const only = positionals[0];
  const entries = await verdictsAndLabels(io, values.project);
  const labels = labelsByVerdict(entries);
  const labeled = entries.filter(
    (entry): entry is VerdictEntry =>
      entry.kind === "verdict" &&
      labels.has(entry.id) &&
      entry.body.judged_by !== null &&
      (only === undefined || entry.body.battery_id === only) &&
      batteryById(entry.body.battery_id) !== undefined,
  );
  const judgment = judgmentOf(io, {
    cached: false,
    ...(values.source === undefined ? {} : { onlySource: values.source }),
  });
  const tally = new Map<
    string,
    { tp: number; fp: number; tn: number; fn: number; wrong: string[] }
  >();
  const results = await settleMany(
    labeled,
    async (entry) => {
      const battery = batteryById(entry.body.battery_id);
      if (battery === undefined) throw new Error("battery removed");
      return battery.replay(entry.body.input, {
        provider: judgment.provider,
        thresholdsFor: judgment.thresholdsFor,
      });
    },
    8,
  );
  results.forEach((result, index) => {
    const entry = labeled[index];
    const label = entry === undefined ? undefined : labels.get(entry.id);
    if (entry === undefined || label === undefined) return;
    const counts = tally.get(entry.body.battery_id) ?? {
      tp: 0,
      fp: 0,
      tn: 0,
      fn: 0,
      wrong: [],
    };
    tally.set(entry.body.battery_id, counts);
    if (!result.ok) {
      counts.wrong.push(`UNREAD ${entry.id}: ${String(result.error)}`);
      return;
    }
    const shouldStop = label.right ? stops(entry) : !stops(entry);
    const stopped = result.value.stops;
    if (stopped && shouldStop) counts.tp += 1;
    else if (stopped) counts.fp += 1;
    else if (shouldStop) counts.fn += 1;
    else counts.tn += 1;
    if (stopped !== shouldStop)
      counts.wrong.push(
        `${stopped ? "FP" : "FN"} ${entry.id} ${JSON.stringify(result.value.decision)} ${JSON.stringify(entry.body.input).slice(0, 160)}`,
      );
  });
  if (tally.size === 0) io.out("no labeled verdicts to replay");
  for (const [id, counts] of tally) {
    const precision =
      counts.tp + counts.fp === 0
        ? "n/a"
        : fixed(counts.tp / (counts.tp + counts.fp));
    const recall =
      counts.tp + counts.fn === 0
        ? "n/a"
        : fixed(counts.tp / (counts.tp + counts.fn));
    io.out(
      `${id}: tp ${counts.tp} fp ${counts.fp} tn ${counts.tn} fn ${counts.fn}; precision ${precision} recall ${recall}`,
    );
    for (const line of counts.wrong) io.out(`   ${line}`);
  }
  return 0;
}
