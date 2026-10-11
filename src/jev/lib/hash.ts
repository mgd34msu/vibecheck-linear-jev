// Canonical JSON and hashing. The request hash keys the cache, so two callers
// with the same content hash the same way regardless of key order.

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      sorted[key] = sortKeys(entry);
    return sorted;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash of the content a request is judged on: model, questions and state. */
export function requestHash(input: {
  readonly model: string;
  readonly questions: unknown;
  readonly state: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      model: input.model,
      questions: input.questions,
      state: input.state,
    }),
  );
}

/** Hash of state alone, for grouping decisions about the same content. */
export function stateHash(state: unknown): string {
  return sha256Hex(canonicalJson(state ?? null));
}
