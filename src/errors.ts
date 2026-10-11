// BoardError: the one error a ledger tool returns to its caller. `invalid`
// means the request must change, `not_found` that it names something that
// does not exist, `conflict` that the ledger's state disagrees with it (a
// stale revision, a claim another agent won), `forbidden` that this session
// may not do it, and `unavailable` that Linear could not be reached or
// refused the key; the request may succeed when repeated later.

export type BoardErrorCode =
  "invalid" | "conflict" | "forbidden" | "not_found" | "unavailable";

export interface ValidationIssue {
  field: (string | number)[];
  message: string;
  type: string;
}

export type DetailValue = string | number | boolean | null | readonly string[];

export type BoardErrorDetails =
  ValidationIssue[] | Readonly<Record<string, DetailValue>>;

export interface BoardErrorResponse {
  code: BoardErrorCode;
  message: string;
  details?: BoardErrorDetails;
}

export class BoardError extends Error {
  readonly code: BoardErrorCode;
  readonly details: BoardErrorDetails | undefined;

  constructor(
    code: BoardErrorCode,
    message: string,
    details?: BoardErrorDetails,
  ) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.details = details;
  }

  asDict(): BoardErrorResponse {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  toJSON(): BoardErrorResponse {
    return this.asDict();
  }
}
