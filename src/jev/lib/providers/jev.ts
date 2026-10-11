// Adapter over @typesafe-ai/sdk. It speaks the System One wire API, so it
// serves the hosted TypeSafe service, open Jev-compatible servers and the
// local Laya server alike; only the base URL, auth and model differ.

import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";
import { answerSchema, type Answer } from "../answers.js";
import {
  AuthError,
  InvalidRequestError,
  MalformedAnswerError,
  ProviderUnavailableError,
  RateLimitedError,
} from "../errors.js";
import {
  DEFAULT_MODEL,
  type EvaluateRequest,
  type Evaluation,
  type InputLimits,
  type ModelInfo,
  type SystemOneProvider,
} from "../provider.js";
import type { Question, Questions } from "../questions.js";

export interface JevProviderOptions {
  /** Source id stamped on every evaluation and verdict. */
  readonly id: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly model?: string;
  /** Per-attempt timeout in milliseconds. Default 10000. */
  readonly timeoutMs?: number;
  readonly limits?: InputLimits;
  /** Attempts per reading before the chain moves on. Default 1 inside a chain. */
  readonly maxRetries?: number;
  readonly fetch?: TypeSafeClientConfig["fetch"];
}

function mapAnswer(raw: unknown, question: Question): Answer {
  const parsed = answerSchema.safeParse(normalizeScore(raw, question));
  if (!parsed.success)
    throw new MalformedAnswerError(
      `answer does not match its question: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  const answer = parsed.data;
  if (answer.type === "score")
    return {
      ...answer,
      legend: question.type === "score" ? [...question.criteria] : [],
    };
  return answer;
}

/** The wire keys score probabilities by level; the layer holds them as an array. */
function normalizeScore(raw: unknown, question: Question): unknown {
  if (
    question.type !== "score" ||
    typeof raw !== "object" ||
    raw === null ||
    !("probabilities" in raw)
  )
    return raw;
  const probabilities = raw.probabilities;
  if (typeof probabilities !== "object" || probabilities === null) return raw;
  const levels: unknown[] = [];
  for (let level = 0; level < question.criteria.length; level++)
    levels.push(
      Array.isArray(probabilities)
        ? probabilities[level]
        : Object.entries(probabilities).find(
            ([key]) => key === String(level),
          )?.[1],
    );
  return { ...raw, probabilities: levels, legend: [] };
}

export function mapProviderError(error: unknown): never {
  if (error instanceof RateLimitError)
    throw new RateLimitedError(
      `rate limited (${error.status})`,
      error.retryAfterMs,
      { cause: error },
    );
  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError
  )
    throw new AuthError(`authentication failed (${error.status})`, {
      cause: error,
    });
  if (
    error instanceof BadRequestError ||
    error instanceof UnprocessableEntityError
  )
    throw new InvalidRequestError(
      `request rejected (${error.status}): ${describeBody(error.body)}`,
      { cause: error },
    );
  if (error instanceof APIError) {
    if (error.status >= 500)
      throw new ProviderUnavailableError(`provider error (${error.status})`, {
        cause: error,
      });
    throw new InvalidRequestError(`request failed (${error.status})`, {
      cause: error,
    });
  }
  if (error instanceof APIUserAbortError) throw error;
  if (error instanceof APIConnectionError)
    throw new ProviderUnavailableError(error.message, { cause: error });
  if (error instanceof TypeError)
    throw new ProviderUnavailableError(error.message, { cause: error });
  throw error;
}

function describeBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  if (body === undefined) return "empty body";
  return JSON.stringify(body).slice(0, 300);
}

function mapAnswers(
  rawAnswers: Readonly<Record<string, unknown>>,
  questions: Questions,
): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = rawAnswers[id];
    if (raw === undefined)
      throw new MalformedAnswerError(`no answer for question "${id}"`);
    answers[id] = mapAnswer(raw, question);
  }
  return answers;
}

export class JevProvider implements SystemOneProvider {
  readonly id: string;
  readonly defaultModel: string;
  readonly limits: InputLimits | undefined;
  readonly #client: TypeSafeClient;

  constructor(options: JevProviderOptions) {
    this.#client = new TypeSafeClient({
      // A local open server may need no key; the SDK requires a value.
      apiKey: options.apiKey ?? "unused",
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(options.model === undefined ? {} : { defaultModel: options.model }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeout: options.timeoutMs }),
      ...(options.headers === undefined
        ? {}
        : { defaultHeaders: { ...options.headers } }),
      retry: { maxRetries: options.maxRetries ?? 1 },
      logLevel: "off",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.id = options.id;
    this.defaultModel = options.model ?? DEFAULT_MODEL;
    this.limits = options.limits;
  }

  async evaluate(request: EvaluateRequest): Promise<Evaluation> {
    const started = performance.now();
    try {
      const response = await this.#client
        .systemOne(
          {
            state: request.state,
            questions: request.questions,
            model: request.model ?? this.defaultModel,
          },
          request.signal === undefined ? {} : { signal: request.signal },
        )
        .withResponse();
      const result = response.data;
      const raw: Readonly<Record<string, unknown>> = result.answers;
      return {
        answers: mapAnswers(raw, request.questions),
        model: result.model,
        usage: {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        },
        latencyMs: performance.now() - started,
        providerId: this.id,
        provenance: "system-one",
        ...(response.requestId === undefined
          ? {}
          : { requestId: response.requestId }),
      };
    } catch (error) {
      mapProviderError(error);
    }
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    try {
      const cards = await this.#client.models.list();
      return cards.map((card) => ({
        name: card.name,
        description: card.description,
        releaseDate: card.release_date,
      }));
    } catch (error) {
      mapProviderError(error);
    }
  }
}
