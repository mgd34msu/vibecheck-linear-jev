// Check results rendered as ledger history entries.

import { jsonValueSchema } from "../schemas.js";
import type {
  Evidence,
  NewEntry,
  Outcome,
  ReadingRecord,
} from "../verification/store.js";
import type { CheckResult } from "./judgment.js";
import type { Battery, BatteryRun, Decision, Questions } from "./lib/index.js";

export interface EntryContext {
  readonly source: string;
  readonly evidence?: Evidence;
  readonly externalSessionId?: string;
  readonly reportedStatus?: string;
  readonly appliedStatus?: string;
}

/** Flags block; gates fail; a decision asking for review is review; anything else passed. */
export function outcomeOf(decision: Decision, gate: boolean): Outcome {
  if (decision.block) return gate ? "failed" : "flagged";
  return decision.review === true ? "review" : "passed";
}

function readings<Q extends Questions, D>(
  run: BatteryRun<Q, D>,
): ReadingRecord[] {
  return run.readings.map((reading) => ({
    question_id: reading.questionId,
    type: reading.type,
    value: reading.value,
    ...(reading.confidence === undefined
      ? {}
      : { confidence: reading.confidence }),
    distribution: [...reading.distribution],
  }));
}

export function verdictEntry<
  I,
  Q extends Questions,
  K extends string,
  D extends Decision,
>(
  battery: Battery<I, Q, K, D>,
  input: I,
  run: BatteryRun<Q, D>,
  context: EntryContext & {
    readonly outcome: Outcome;
    readonly reason: string;
  },
): NewEntry {
  const evaluation = run.evaluation;
  return {
    kind: "verdict",
    body: {
      battery_id: battery.id,
      battery_version: battery.version,
      run_id: run.runId,
      source: context.source,
      outcome: context.outcome,
      reason: context.reason,
      decision: jsonValueSchema.parse(JSON.parse(JSON.stringify(run.decision))),
      readings: readings(run),
      thresholds: { ...run.thresholds },
      judged_by: {
        source_id: evaluation.providerId,
        model: evaluation.model,
        provenance: evaluation.provenance,
        latency_ms: Math.round(evaluation.latencyMs),
        input_tokens: evaluation.usage.inputTokens,
        ...(evaluation.skipped === undefined
          ? {}
          : {
              skipped: evaluation.skipped.map((skip) => ({
                source_id: skip.sourceId,
                reason: skip.reason,
              })),
            }),
      },
      input: jsonValueSchema.parse(JSON.parse(JSON.stringify(input))),
      ...common(context),
    },
  };
}

function common(context: EntryContext) {
  return {
    ...(context.evidence === undefined ? {} : { evidence: context.evidence }),
    ...(context.reportedStatus === undefined
      ? {}
      : { reported_status: context.reportedStatus }),
    ...(context.appliedStatus === undefined
      ? {}
      : { applied_status: context.appliedStatus }),
    ...(context.externalSessionId === undefined
      ? {}
      : { external_session_id: context.externalSessionId }),
  };
}

/** A decision code made with no reading, such as a commit that touched no claimed path. */
export function deterministicEntry(
  batteryId: string,
  input: unknown,
  decision: Decision & Record<string, unknown>,
  context: EntryContext & {
    readonly outcome: Outcome;
    readonly reason: string;
  },
): NewEntry {
  return {
    kind: "verdict",
    body: {
      battery_id: batteryId,
      battery_version: 1,
      run_id: `code:${batteryId}`,
      source: context.source,
      outcome: context.outcome,
      reason: context.reason,
      decision: jsonValueSchema.parse(JSON.parse(JSON.stringify(decision))),
      readings: [],
      thresholds: {},
      judged_by: null,
      input: jsonValueSchema.parse(JSON.parse(JSON.stringify(input ?? null))),
      ...common(context),
    },
  };
}

export function unavailableEntry<I>(
  battery: { readonly id: string; readonly version: number },
  input: I,
  error: string,
  context: EntryContext,
): NewEntry {
  return {
    kind: "unavailable",
    body: {
      battery_id: battery.id,
      battery_version: battery.version,
      source: context.source,
      error,
      input: jsonValueSchema.parse(JSON.parse(JSON.stringify(input))),
      ...(context.evidence === undefined ? {} : { evidence: context.evidence }),
      ...(context.externalSessionId === undefined
        ? {}
        : { external_session_id: context.externalSessionId }),
    },
  };
}

/** The entry for a check result; nothing for a disabled check. */
export function entryFor<
  I,
  Q extends Questions,
  K extends string,
  D extends Decision,
>(
  battery: Battery<I, Q, K, D>,
  input: I,
  result: CheckResult<Q, D>,
  context: EntryContext & {
    readonly gate: boolean;
    readonly reason: (decision: D) => string;
  },
): NewEntry | undefined {
  switch (result.kind) {
    case "disabled":
      return undefined;
    case "unavailable":
      return unavailableEntry(battery, input, result.error, context);
    case "verdict":
      return verdictEntry(battery, input, result.run, {
        ...context,
        outcome: outcomeOf(result.run.decision, context.gate),
        reason: context.reason(result.run.decision),
      });
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
