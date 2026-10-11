// Answers: provider-neutral typed results.
//
// Every provider returns these shapes. Distributions are always present so
// code can compute its own confidence measure when a summary does not fit.

import { z } from "zod";
import { MalformedAnswerError } from "./errors.js";
import type {
  ChoiceQuestion,
  EntryType,
  NoulQuestion,
  Question,
  Questions,
  ScoreQuestion,
} from "./questions.js";

export interface NoulAnswer {
  readonly type: "noul";
  /** Probability that the answer is yes, 0 to 1. */
  readonly noul: number;
}

export interface ChoiceAnswer<Label extends string = string> {
  readonly type: "choice";
  readonly choice: Label;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<Label, number>>;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: readonly number[];
  readonly legend: readonly EntryType[];
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type a question produces, preserving Choice labels. */
export type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer C>
    ? ChoiceAnswer<keyof C & string>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

/** Answers keyed like the questions that produced them. */
export type AnswersFor<Q extends Questions> = {
  readonly [K in keyof Q]: AnswerFor<Q[K]>;
};

const unit = z
  .number()
  .min(-1e-9)
  .max(1 + 1e-9);

/** The wire shape of one answer, validated before anything reads it. */
export const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: unit }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: unit,
    probabilities: z.record(z.string(), unit),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    confidence: unit,
    probabilities: z.array(unit),
    legend: z.array(z.unknown()),
  }),
]);

type WireAnswer = z.infer<typeof answerSchema>;

function checkAnswer(id: string, question: Question, answer: WireAnswer): void {
  if (answer.type !== question.type)
    throw new MalformedAnswerError(
      `question "${id}" is ${question.type} but the answer is ${answer.type}`,
    );
  if (answer.type === "choice" && question.type === "choice") {
    const labels = Object.keys(question.criteria);
    if (!labels.includes(answer.choice))
      throw new MalformedAnswerError(
        `choice "${id}" picked "${answer.choice}", not one of the options`,
      );
    for (const label of labels)
      if (answer.probabilities[label] === undefined)
        throw new MalformedAnswerError(
          `choice "${id}" has no probability for "${label}"`,
        );
  }
  if (answer.type === "score" && question.type === "score") {
    const levels = question.criteria.length;
    if (answer.probabilities.length !== levels)
      throw new MalformedAnswerError(
        `score "${id}" has ${answer.probabilities.length} level probabilities for ${levels} levels`,
      );
    if (answer.score < 0 || answer.score > levels - 1)
      throw new MalformedAnswerError(`score "${id}" is outside the rubric`);
  }
}

/**
 * Check that a raw answer map matches the question set it was asked for:
 * every question answered, every answer of the matching type and every
 * probability a finite unit value. Narrows the map to the typed shape.
 */
export function isAnswersFor<Q extends Questions>(
  questions: Q,
  answers: unknown,
): answers is AnswersFor<Q> {
  const record = z.record(z.string(), answerSchema).parse(answers);
  for (const [id, question] of Object.entries(questions)) {
    const answer = record[id];
    if (answer === undefined)
      throw new MalformedAnswerError(`no answer for question "${id}"`);
    checkAnswer(id, question, answer);
  }
  return true;
}

/** The validated, typed answers for a question set. */
export function typedAnswers<Q extends Questions>(
  questions: Q,
  answers: Readonly<Record<string, Answer>>,
): AnswersFor<Q> {
  if (isAnswersFor(questions, answers)) return answers;
  throw new MalformedAnswerError("answers do not match the questions");
}

/** Options of a Choice in descending probability. */
export function rankedOptions<Label extends string>(
  answer: ChoiceAnswer<Label>,
): ReadonlyArray<readonly [Label, number]> {
  const probabilities: Readonly<Record<Label, number>> = answer.probabilities;
  const entries: [Label, number][] = [];
  for (const label of Object.keys(probabilities)) {
    if (!isLabel(probabilities, label)) continue;
    entries.push([label, probabilities[label]]);
  }
  return entries.sort((left, right) => right[1] - left[1]);
}

function isLabel<Label extends string>(
  probabilities: Readonly<Record<Label, number>>,
  label: string,
): label is Label {
  return Object.hasOwn(probabilities, label);
}

/** The margin between the top two options or levels. */
export function topMargin(answer: ChoiceAnswer | ScoreAnswer): number {
  const values =
    answer.type === "choice"
      ? Object.values<number>(answer.probabilities)
      : [...answer.probabilities];
  const sorted = values.sort((left, right) => right - left);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

/** A single value per answer, for logging and for comparing across repeats. */
export function primaryValue(answer: Answer): number | string {
  switch (answer.type) {
    case "noul":
      return answer.noul;
    case "choice":
      return answer.choice;
    case "score":
      return answer.score;
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}

/** The distribution of an answer; Choice labels sorted so the order is stable. */
export function distributionOf(answer: Answer): readonly number[] {
  switch (answer.type) {
    case "noul":
      return [1 - answer.noul, answer.noul];
    case "choice": {
      const probabilities: Readonly<Record<string, number>> =
        answer.probabilities;
      return Object.keys(probabilities)
        .sort()
        .map((label) => probabilities[label] ?? 0);
    }
    case "score":
      return answer.probabilities;
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}

/** The number a fixture bound is judged by for one answer. */
export function confidenceOf(answer: Answer): number | undefined {
  return answer.type === "noul" ? undefined : answer.confidence;
}
