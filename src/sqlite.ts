// SQLite plumbing shared by the local store and the verification history:
// the value types bun:sqlite binds, the row access the history functions take,
// a canonical JSON encoding for stored bodies and request hashes, and
// detection of SQLite's busy and locked errors. Bun is the only runtime.

import type { z } from "zod";
import { jsonValueSchema, type JsonValue } from "./schemas.js";

export type SqlValue = string | number | bigint | null | Uint8Array;

/** Row access the verification history uses (src/verification/store.ts). */
export interface SqlAccess {
  readonly now: string;
  queryRows<T>(schema: z.ZodType<T>, sql: string, values: SqlValue[]): T[];
  execute(sql: string, values: SqlValue[]): void;
}

function compareCodepoints(left: string, right: string): number {
  const leftPoints = Array.from(
    left,
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0) ?? 0,
  );
  for (const [index, point] of leftPoints.entries()) {
    const other = rightPoints[index];
    if (other === undefined) return 1;
    if (point !== other) return point - other;
  }
  return leftPoints.length - rightPoints.length;
}

function encodeJson(value: JsonValue): string {
  if (value === null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareCodepoints(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${encodeJson(child)}`)
    .join(",")}}`;
}

/** Canonical JSON: object keys sorted by code point, so equal values encode equally. */
export function encode(value: unknown): string {
  return encodeJson(jsonValueSchema.parse(value));
}

/** True for SQLite's busy and locked errors. */
export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code =
    "errcode" in error
      ? error.errcode
      : "errno" in error
        ? error.errno
        : undefined;
  return typeof code === "number" && ((code & 255) === 5 || (code & 255) === 6);
}
