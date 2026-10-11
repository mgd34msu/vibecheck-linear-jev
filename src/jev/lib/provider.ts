// The System One provider interface. Everything above this file codes against
// SystemOneProvider: a hosted TypeSafe source, an open Jev-compatible server,
// a local Laya server, the failover chain over them, the cache and the
// scripted provider used by tests.

import type { Answer } from "./answers.js";
import type { EntryType, Questions } from "./questions.js";

/** Where an evaluation came from. Logged with every reading. */
export type Provenance = "system-one" | "cache" | "scripted";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface EvaluateRequest<Q extends Questions = Questions> {
  readonly state: EntryType;
  readonly questions: Q;
  /** The battery asking, so a chain can route or skip per battery. */
  readonly batteryId?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/** A source passed over for one reading, and why. */
export interface SourceSkip {
  readonly sourceId: string;
  readonly reason: string;
}

export interface Evaluation {
  readonly answers: Readonly<Record<string, Answer>>;
  /** The versioned model that answered, as the source reported it. */
  readonly model: string;
  readonly usage: Usage;
  readonly latencyMs: number;
  /** The configured source id that answered. */
  readonly providerId: string;
  readonly provenance: Provenance;
  readonly requestId?: string;
  /** Sources skipped before this one answered. */
  readonly skipped?: readonly SourceSkip[];
}

export interface ModelInfo {
  readonly name: string;
  readonly description: string;
  readonly releaseDate: string;
}

export interface SystemOneProvider {
  readonly id: string;
  readonly defaultModel: string;
  evaluate(request: EvaluateRequest): Promise<Evaluation>;
  listModels?(): Promise<readonly ModelInfo[]>;
}

/** Input limits a source declares; a reading over a limit goes to the next source. */
export interface InputLimits {
  readonly maxStateTokens?: number | undefined;
  readonly maxOptionTokens?: number | undefined;
  readonly maxOptions?: number | undefined;
}

/**
 * A conservative token estimate for limit checks: about three characters per
 * token for English and code. It decides whether a request fits a source, not
 * what any text means.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text ?? "").length / 3);
}

/** The first limit a request exceeds, or undefined when it fits. */
export function exceededLimit(
  request: EvaluateRequest,
  limits: InputLimits | undefined,
): string | undefined {
  if (limits === undefined) return undefined;
  const stateTokens = estimateTokens(request.state);
  if (
    limits.maxStateTokens !== undefined &&
    stateTokens > limits.maxStateTokens
  )
    return `state of about ${stateTokens} tokens exceeds ${limits.maxStateTokens}`;
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== "choice") continue;
    const options = Object.entries(question.criteria);
    if (limits.maxOptions !== undefined && options.length > limits.maxOptions)
      return `question ${id} has ${options.length} options, over ${limits.maxOptions}`;
    for (const [label, description] of options) {
      const tokens = estimateTokens(`${label}: ${JSON.stringify(description)}`);
      if (
        limits.maxOptionTokens !== undefined &&
        tokens > limits.maxOptionTokens
      )
        return `option ${label} of question ${id} is about ${tokens} tokens, over ${limits.maxOptionTokens}`;
    }
  }
  return undefined;
}

export const DEFAULT_MODEL = "jev-latest";
