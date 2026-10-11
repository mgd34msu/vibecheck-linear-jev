// Batteries: input schema, questions, thresholds, state builder and decision
// in one place. A battery is the reviewable unit of judgment: nothing else
// constructs a question inline, and a reviewer reads one battery to know what
// a check decides and how sure it must be.

import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  confidenceOf,
  distributionOf,
  primaryValue,
  typedAnswers,
  type AnswersFor,
} from "./answers.js";
import type {
  EvaluateRequest,
  Evaluation,
  SystemOneProvider,
} from "./provider.js";
import {
  assertLint,
  type EntryType,
  type LintFinding,
  type Questions,
} from "./questions.js";

export type Expectation =
  | { readonly kind: "noul"; readonly min: number; readonly max: number }
  | {
      readonly kind: "choice";
      readonly choice: string;
      readonly minConfidence?: number;
    }
  | { readonly kind: "score"; readonly min: number; readonly max: number };

export interface Fixture<I> {
  readonly name: string;
  readonly input: I;
  /** Expected answers per question id. Absent ids are not checked. */
  readonly expect: Readonly<Record<string, Expectation>>;
}

export type Thresholds<K extends string> = Readonly<Record<K, number>>;

/** Every decision says whether it stops the work; `review` asks a person to look. */
export interface Decision {
  readonly block: boolean;
  readonly review?: boolean;
}

export interface DecideContext<I, Q extends Questions, K extends string> {
  readonly input: I;
  readonly answers: AnswersFor<Q>;
  readonly thresholds: Thresholds<K>;
}

export interface BatterySpec<
  I,
  Q extends Questions,
  K extends string,
  D extends Decision,
> {
  /** Stable id such as vibecheck.claims-done. */
  readonly id: string;
  /** Increment on any wording or threshold change. Logged with every reading. */
  readonly version: number;
  /** One or two sentences on what this battery decides and for whom. */
  readonly purpose: string;
  /** Validates the input read from logs, imports and replays. */
  readonly input: z.ZodType<I>;
  /** Trim the input to the state the questions need. */
  readonly state: (input: I) => EntryType;
  readonly questions: Q;
  /** Named thresholds, each a probability from 0 to 1; configured overrides replace individual values. */
  readonly thresholds: Thresholds<K>;
  /** Turn answers into an action. Pure. */
  readonly decide: (context: DecideContext<I, Q, K>) => D;
  readonly fixtures: readonly Fixture<I>[];
}

export interface Battery<
  I,
  Q extends Questions,
  K extends string,
  D extends Decision,
> extends BatterySpec<I, Q, K, D> {
  readonly lint: readonly LintFinding[];
}

export function defineBattery<
  I,
  const Q extends Questions,
  K extends string,
  D extends Decision,
>(spec: BatterySpec<I, Q, K, D>): Battery<I, Q, K, D> {
  const first = spec.fixtures[0];
  const state = first === undefined ? undefined : spec.state(first.input);
  const lint = assertLint(spec.questions, {
    stateIsStructured: typeof state === "object" && state !== null,
  });
  return { ...spec, lint };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** Per-source threshold overrides for one battery, from configuration. */
export type ThresholdResolver = (
  batteryId: string,
  sourceId: string,
) => Readonly<Record<string, number>> | undefined;

export interface RunOptions {
  readonly provider: SystemOneProvider;
  readonly signal?: AbortSignal;
  readonly thresholdsFor?: ThresholdResolver;
}

/** One answered question, kept with the verdict it fed. */
export interface Reading {
  readonly questionId: string;
  readonly type: "noul" | "choice" | "score";
  readonly value: number | string;
  readonly confidence?: number;
  readonly distribution: readonly number[];
}

export interface BatteryRun<Q extends Questions, D> {
  readonly runId: string;
  readonly decision: D;
  readonly answers: AnswersFor<Q>;
  readonly evaluation: Evaluation;
  readonly readings: readonly Reading[];
  readonly thresholds: Readonly<Record<string, number>>;
}

function isThresholdKey<K extends string>(
  base: Thresholds<K>,
  key: string,
): key is K {
  return Object.hasOwn(base, key);
}

/** The battery's thresholds with any per-source override applied, key by key. */
export function applyThresholds<K extends string>(
  base: Thresholds<K>,
  override: Readonly<Record<string, number>> | undefined,
): Thresholds<K> {
  if (override === undefined) return base;
  const merged: Record<K, number> = { ...base };
  for (const [key, value] of Object.entries(override))
    if (isThresholdKey(base, key)) merged[key] = value;
  return merged;
}

export async function runBattery<
  I,
  Q extends Questions,
  K extends string,
  D extends Decision,
>(
  battery: Battery<I, Q, K, D>,
  input: I,
  options: RunOptions,
): Promise<BatteryRun<Q, D>> {
  const state = battery.state(input);
  const request: EvaluateRequest<Q> = {
    state,
    questions: battery.questions,
    batteryId: battery.id,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const evaluation = await options.provider.evaluate(request);
  const answers = typedAnswers(battery.questions, evaluation.answers);
  const thresholds = applyThresholds(
    battery.thresholds,
    options.thresholdsFor?.(battery.id, evaluation.providerId),
  );
  const decision = battery.decide({ input, answers, thresholds });
  const readings: Reading[] = [];
  for (const [questionId, question] of Object.entries(battery.questions)) {
    const answer = evaluation.answers[questionId];
    if (answer === undefined) continue;
    const confidence = confidenceOf(answer);
    readings.push({
      questionId,
      type: question.type,
      value: primaryValue(answer),
      ...(confidence === undefined ? {} : { confidence }),
      distribution: [...distributionOf(answer)],
    });
  }
  return {
    runId: randomUUID(),
    decision,
    answers,
    evaluation,
    readings,
    thresholds,
  };
}

export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** Run many jobs with bounded concurrency. Order is preserved; failures are returned. */
export async function settleMany<T, R>(
  inputs: readonly T[],
  job: (input: T, index: number) => Promise<R>,
  concurrency = 8,
): Promise<Settled<R>[]> {
  const results: Settled<R>[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const input = inputs[index];
      if (index >= inputs.length || input === undefined) return;
      try {
        results[index] = { ok: true, value: await job(input, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), inputs.length) },
      worker,
    ),
  );
  return results;
}
