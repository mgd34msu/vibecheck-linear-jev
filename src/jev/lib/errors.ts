// Errors raised by the judgment layer.

/** Base class for every error the judgment layer raises. */
export class JudgmentError extends Error {
  override readonly name: string = "JudgmentError";
}

/** A question or battery failed validation before any request was made. */
export class InvalidQuestionError extends JudgmentError {
  override readonly name = "InvalidQuestionError";
}

/** The provider rejected the request as malformed (HTTP 400 or 422). */
export class InvalidRequestError extends JudgmentError {
  override readonly name = "InvalidRequestError";
}

/** Authentication with the provider failed (HTTP 401 or 403). */
export class AuthError extends JudgmentError {
  override readonly name = "AuthError";
}

/** The provider rate-limited or shed the request (HTTP 429 or 529). */
export class RateLimitedError extends JudgmentError {
  override readonly name = "RateLimitedError";
  readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    retryAfterMs: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.retryAfterMs = retryAfterMs;
  }
}

/** The provider could not be reached or did not answer in time. */
export class ProviderUnavailableError extends JudgmentError {
  override readonly name = "ProviderUnavailableError";
}

/** A provider answered with a shape the layer could not accept. */
export class MalformedAnswerError extends JudgmentError {
  override readonly name = "MalformedAnswerError";
}

/** Every configured source was skipped or unavailable for one reading. */
export class NoSourceError extends JudgmentError {
  override readonly name = "NoSourceError";
  /** True when every source was skipped only because the reading exceeded its input limits. */
  readonly overLimits: boolean;
  constructor(message: string, overLimits = false, options?: ErrorOptions) {
    super(message, options);
    this.overLimits = overLimits;
  }
}

/** True when the error is one the layer may retry through the next source. */
export function isTransient(error: unknown): boolean {
  return (
    error instanceof RateLimitedError ||
    error instanceof ProviderUnavailableError
  );
}
