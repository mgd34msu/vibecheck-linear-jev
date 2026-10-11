// Questions: the three System One primitives, validated at construction.
//
// The types are the SDK's own, so a battery's questions go to the adapter
// unchanged. The builders add the limits the API enforces, so a bad question
// fails at definition time instead of at request time.

import type {
  ChoiceCriteria,
  ChoiceQuestion,
  EntryType,
  NoulQuestion,
  Question,
  Questions,
  ScoreCriteria,
  ScoreQuestion,
} from "@typesafe-ai/sdk";
import { InvalidQuestionError } from "./errors.js";

export type {
  ChoiceCriteria,
  ChoiceQuestion,
  Description,
  EntryType,
  JsonValue,
  NoulQuestion,
  Question,
  Questions,
  ScoreCriteria,
  ScoreQuestion,
} from "@typesafe-ai/sdk";

/** Hard limits published for the API. */
export const LIMITS = {
  scoreLevelsMin: 2,
  scoreLevelsMax: 10,
  choiceOptionsMax: 255,
};

function assertInstructions(instructions: EntryType, where: string): void {
  if (instructions === null)
    throw new InvalidQuestionError(`${where}: instructions are required`);
  if (typeof instructions === "string" && instructions.trim().length === 0)
    throw new InvalidQuestionError(`${where}: instructions are empty`);
}

/** A yes/no question. The answer is the probability that yes is correct. */
export function noul(
  instructions: EntryType,
  criteria?: NoulQuestion["criteria"],
): NoulQuestion {
  assertInstructions(instructions, "noul");
  if (criteria !== undefined && criteria !== null) {
    const hasTrue = criteria.true !== undefined && criteria.true !== null;
    const hasFalse = criteria.false !== undefined && criteria.false !== null;
    if (hasTrue !== hasFalse)
      throw new InvalidQuestionError("noul: describe both outcomes or neither");
    return { type: "noul", instructions, criteria };
  }
  return { type: "noul", instructions };
}

/** Pick one option from a named set. The answer carries the full distribution. */
export function choice<const T extends ChoiceCriteria>(
  instructions: EntryType,
  criteria: T,
): ChoiceQuestion<T> {
  assertInstructions(instructions, "choice");
  const count = Object.keys(criteria).length;
  if (count === 0)
    throw new InvalidQuestionError("choice: at least one option is required");
  if (count > LIMITS.choiceOptionsMax)
    throw new InvalidQuestionError(
      `choice: ${count} options exceeds the limit of ${LIMITS.choiceOptionsMax}`,
    );
  return { type: "choice", instructions, criteria };
}

/** Place the state on an ordered rubric. Level numbers are array positions. */
export function score<const T extends ScoreCriteria>(
  instructions: EntryType,
  criteria: T,
): ScoreQuestion<T> {
  assertInstructions(instructions, "score");
  if (
    criteria.length < LIMITS.scoreLevelsMin ||
    criteria.length > LIMITS.scoreLevelsMax
  )
    throw new InvalidQuestionError(
      `score: ${criteria.length} levels; the rubric takes ${LIMITS.scoreLevelsMin} to ${LIMITS.scoreLevelsMax}`,
    );
  return { type: "score", instructions, criteria };
}

// ---------------------------------------------------------------------------
// Lint: structural rules applied to a question set
// ---------------------------------------------------------------------------

export type LintLevel = "error" | "warn";

export interface LintFinding {
  readonly level: LintLevel;
  readonly questionId: string;
  readonly rule: string;
  readonly message: string;
}

const NUMERIC_ONLY = /^\s*[\d.]+\s*$/u;
const BACKTICK_PATH = /`[^`]+`/u;

function instructionText(instructions: EntryType | undefined): string {
  if (instructions === undefined || instructions === null) return "";
  return typeof instructions === "string"
    ? instructions
    : JSON.stringify(instructions);
}

/**
 * Check a question set against the structural rules: things the API will not
 * accept are errors; a structured state whose question names no backticked
 * field, and a single-option choice, are warnings.
 */
export function lintQuestions(
  questions: Questions,
  options: { readonly stateIsStructured?: boolean } = {},
): LintFinding[] {
  const findings: LintFinding[] = [];
  const push = (
    level: LintLevel,
    questionId: string,
    rule: string,
    message: string,
  ): void => {
    findings.push({ level, questionId, rule, message });
  };
  if (Object.keys(questions).length === 0) {
    push("error", "", "empty-set", "a request needs at least one question");
    return findings;
  }
  for (const [id, question] of Object.entries(questions)) {
    const text = instructionText(question.instructions);
    if (text.trim().length === 0)
      push(
        "error",
        id,
        "empty-instructions",
        "instructions are empty; the id is not sent to the model",
      );
    if (options.stateIsStructured === true && !BACKTICK_PATH.test(text))
      push(
        "warn",
        id,
        "unnamed-field",
        "the state is structured but the question names no backticked field",
      );
    lintQuestion(id, question, push);
  }
  return findings;
}

function lintQuestion(
  id: string,
  question: Question,
  push: (
    level: LintLevel,
    questionId: string,
    rule: string,
    message: string,
  ) => void,
): void {
  switch (question.type) {
    case "noul":
      return;
    case "choice": {
      const labels = Object.keys(question.criteria);
      if (labels.length > LIMITS.choiceOptionsMax)
        push(
          "error",
          id,
          "too-many-options",
          `${labels.length} options exceeds ${LIMITS.choiceOptionsMax}`,
        );
      if (labels.length === 1)
        push(
          "warn",
          id,
          "single-option",
          "one option always wins; add the alternatives or use a noul",
        );
      return;
    }
    case "score": {
      const levels: readonly EntryType[] = question.criteria;
      if (
        levels.length < LIMITS.scoreLevelsMin ||
        levels.length > LIMITS.scoreLevelsMax
      )
        push(
          "error",
          id,
          "level-count",
          `${levels.length} levels; the rubric takes ${LIMITS.scoreLevelsMin} to ${LIMITS.scoreLevelsMax}`,
        );
      if (
        levels.every(
          (level) => typeof level === "string" && NUMERIC_ONLY.test(level),
        )
      )
        push(
          "error",
          id,
          "numeric-levels",
          "levels are bare numbers; describe the situation each level names",
        );
      return;
    }
    default: {
      const exhaustive: never = question;
      return exhaustive;
    }
  }
}

/** Throw on lint errors; return the warnings for the caller to keep. */
export function assertLint(
  questions: Questions,
  options: { readonly stateIsStructured?: boolean } = {},
): LintFinding[] {
  const findings = lintQuestions(questions, options);
  const errors = findings.filter((finding) => finding.level === "error");
  if (errors.length > 0)
    throw new InvalidQuestionError(
      `question set failed lint:\n${errors.map((finding) => `${finding.questionId || "(set)"}: ${finding.rule}: ${finding.message}`).join("\n")}`,
    );
  return findings;
}
