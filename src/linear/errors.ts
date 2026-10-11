// LinearError: the one error type every LinearApi implementation throws.
//
// Linear reports most failures inside a GraphQL `errors` array, often with
// HTTP 200. These helpers turn an HTTP status, the `errors` entries and the
// rate-limit headers into a LinearError whose `kind` tells the caller what to
// do: fix the input (invalid), fix the key (auth), wait (rate_limited), or try
// again later (network, server). Shapes observed against Linear on 2026-10-10:
//   - validation failure: HTTP 200, code INVALID_INPUT, userPresentableMessage
//     "color must be a hexadecimal color.";
//   - missing entity: HTTP 200, code INPUT_ERROR, message "Entity not found: Issue";
//   - duplicate client id: HTTP 200, code INPUT_ERROR, userPresentableMessage
//     "Entity Project with id <id> already exists.";
//   - removing a label the issue does not carry: HTTP 200, code INVALID_INPUT,
//     "Label <id> is not on issue <id> and cannot be removed." (2026-10-11);
//   - bad key: HTTP 401, code AUTHENTICATION_ERROR;
//   - unknown field in a query: HTTP 400, code GRAPHQL_VALIDATION_FAILED.

import { z } from "zod";

export type LinearErrorKind =
  "auth" | "rate_limited" | "not_found" | "invalid" | "network" | "server";

export interface LinearErrorOptions {
  /** How long to wait before the next request, for `rate_limited`. */
  readonly retryAfterMs?: number;
  /** HTTP status of the response, when there was one. */
  readonly status?: number;
  /** Linear's `extensions.code`, when it sent one. */
  readonly code?: string;
  readonly cause?: unknown;
}

/** A failed Linear request, classified by what the caller should do next. */
export class LinearError extends Error {
  readonly kind: LinearErrorKind;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    kind: LinearErrorKind,
    message: string,
    options: LinearErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LinearError";
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.code = options.code;
  }

  /** True for failures a later identical request may not repeat. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "server";
  }
}

/** True when `value` is a LinearError, optionally of one of `kinds`. */
export function isLinearError(
  value: unknown,
  ...kinds: readonly LinearErrorKind[]
): value is LinearError {
  return (
    value instanceof LinearError &&
    (kinds.length === 0 || kinds.includes(value.kind))
  );
}

/**
 * True when Linear refused the key itself (HTTP 401 or code
 * AUTHENTICATION_ERROR): every request fails the same way until the key is
 * fixed, so the failure says nothing about the request. A 403 / FORBIDDEN
 * answer is about one entity and is not matched.
 */
export function isKeyRejected(value: unknown): boolean {
  return (
    isLinearError(value, "auth") &&
    (value.status === 401 || value.code === "AUTHENTICATION_ERROR")
  );
}

const LABEL_NOT_ON_ISSUE =
  /^Label \S+ is not on issue \S+ and cannot be removed\.?$/u;

/**
 * True for Linear's refusal to remove a label the issue does not carry:
 * `invalid` with "Label <id> is not on issue <id> and cannot be removed."
 * There is nothing left to remove, so callers treat it as done.
 */
export function isLabelNotOnIssue(value: unknown): boolean {
  return (
    isLinearError(value, "invalid") &&
    LABEL_NOT_ON_ISSUE.test(value.message.trim())
  );
}

/**
 * Removes a label from an issue, treating "the label is not on the issue" as
 * done. Every ledger removal goes through here: Linear refuses to remove a
 * label the issue does not carry, and the tool never trusts its cache to
 * know which labels an issue has.
 */
export async function removeLabelIfPresent(
  api: {
    removeLabel(issueId: string, labelId: string): Promise<void>;
  },
  issueId: string,
  labelId: string,
): Promise<void> {
  try {
    await api.removeLabel(issueId, labelId);
  } catch (error) {
    if (!isLabelNotOnIssue(error)) throw error;
  }
}

/** One entry of a GraphQL response's `errors` array, as Linear sends it. */
export const graphqlErrorSchema = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  extensions: z
    .object({
      code: z.string().optional(),
      type: z.string().optional(),
      statusCode: z.number().optional(),
      userPresentableMessage: z.string().optional(),
    })
    .optional(),
});

export type GraphqlErrorEntry = z.infer<typeof graphqlErrorSchema>;

const AUTH_CODES = new Set(["AUTHENTICATION_ERROR", "FORBIDDEN"]);
const RATE_LIMIT_CODES = new Set(["RATELIMITED", "RATE_LIMITED"]);
const SERVER_CODES = new Set(["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE"]);

/**
 * Milliseconds until Linear's rate-limit window resets, from the
 * `x-ratelimit-*-reset` headers (epoch milliseconds) or `retry-after`
 * (seconds). Uses the window that is exhausted when one is, else the later.
 */
export function retryAfterFromHeaders(
  headers: Headers,
  now: number,
): number | undefined {
  const number = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const windows = [
    {
      remaining: number("x-ratelimit-requests-remaining"),
      reset: number("x-ratelimit-requests-reset"),
    },
    {
      remaining: number("x-ratelimit-complexity-remaining"),
      reset: number("x-ratelimit-complexity-reset"),
    },
  ].filter((window) => window.reset !== undefined);
  const exhausted = windows.filter(
    (window) => window.remaining !== undefined && window.remaining <= 0,
  );
  const candidates = (exhausted.length > 0 ? exhausted : windows).flatMap(
    (window) => (window.reset === undefined ? [] : [window.reset]),
  );
  if (candidates.length > 0) return Math.max(0, Math.max(...candidates) - now);
  const seconds = number("retry-after");
  return seconds === undefined ? undefined : Math.max(0, seconds * 1000);
}

function kindFromStatus(status: number): LinearErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "invalid";
}

function kindFromEntry(
  entry: GraphqlErrorEntry,
  status: number,
): LinearErrorKind {
  const code = entry.extensions?.code;
  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return "auth";
    if (RATE_LIMIT_CODES.has(code)) return "rate_limited";
    if (SERVER_CODES.has(code)) return "server";
  }
  if (/^Entity not found\b/u.test(entry.message)) return "not_found";
  const entryStatus = entry.extensions?.statusCode;
  if (entryStatus !== undefined && entryStatus !== 400)
    return kindFromStatus(entryStatus);
  if (code !== undefined) return "invalid";
  return status >= 400 ? kindFromStatus(status) : "server";
}

const KIND_PRIORITY: readonly LinearErrorKind[] = [
  "auth",
  "rate_limited",
  "server",
  "network",
  "not_found",
  "invalid",
];

/**
 * The LinearError for a response whose body carried GraphQL `errors`. When
 * several entries disagree, the one that most limits what the caller can do
 * wins (auth over rate limit over server over not-found over invalid).
 */
export function errorFromGraphql(
  entries: readonly GraphqlErrorEntry[],
  status: number,
  headers: Headers,
  now: number,
): LinearError {
  const classified = entries.map((entry) => ({
    entry,
    kind: kindFromEntry(entry, status),
  }));
  classified.sort(
    (left, right) =>
      KIND_PRIORITY.indexOf(left.kind) - KIND_PRIORITY.indexOf(right.kind),
  );
  const first = classified[0];
  if (first === undefined) return errorFromHttp(status, headers, now, "");
  const message =
    first.entry.extensions?.userPresentableMessage ?? first.entry.message;
  const code = first.entry.extensions?.code;
  const retryAfterMs =
    first.kind === "rate_limited"
      ? retryAfterFromHeaders(headers, now)
      : undefined;
  return new LinearError(first.kind, message, {
    status,
    ...(code === undefined ? {} : { code }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** The LinearError for a non-2xx response without usable GraphQL errors. */
export function errorFromHttp(
  status: number,
  headers: Headers,
  now: number,
  bodyText: string,
): LinearError {
  const kind = kindFromStatus(status);
  const retryAfterMs =
    kind === "rate_limited" ? retryAfterFromHeaders(headers, now) : undefined;
  const detail = bodyText.trim().slice(0, 200);
  return new LinearError(
    kind,
    `Linear responded with HTTP ${status}${detail === "" ? "" : `: ${detail}`}`,
    { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
  );
}
