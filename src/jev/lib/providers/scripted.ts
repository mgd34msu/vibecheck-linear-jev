// A provider that answers from a script instead of a model. Tests use it so
// hooks and ledger checks run with no network; it answers every question with
// the value the script gives, or a neutral default.

import type { Answer } from "../answers.js";
import { ProviderUnavailableError } from "../errors.js";
import type {
  EvaluateRequest,
  Evaluation,
  SystemOneProvider,
} from "../provider.js";
import type { Question } from "../questions.js";

/** What the script returns for one question: a probability, a label, or a level. */
export type ScriptedValue = number | string;

export type Script = (
  batteryId: string,
  questionId: string,
  state: unknown,
) => ScriptedValue | undefined;

function answerFor(
  question: Question,
  value: ScriptedValue | undefined,
): Answer {
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: typeof value === "number" ? value : 0.1 };
    case "choice": {
      const labels = Object.keys(question.criteria);
      const picked =
        typeof value === "string" && labels.includes(value)
          ? value
          : (labels[0] ?? "");
      const probabilities: Record<string, number> = {};
      for (const label of labels)
        probabilities[label] =
          label === picked ? 0.9 : 0.1 / Math.max(1, labels.length - 1);
      return { type: "choice", choice: picked, confidence: 0.9, probabilities };
    }
    case "score": {
      const levels = question.criteria.length;
      const level = typeof value === "number" ? Math.round(value) : 0;
      return {
        type: "score",
        score: level,
        confidence: 0.9,
        probabilities: Array.from({ length: levels }, (_, index) =>
          index === level ? 1 : 0,
        ),
        legend: [...question.criteria],
      };
    }
    default: {
      const exhaustive: never = question;
      return exhaustive;
    }
  }
}

export class ScriptedProvider implements SystemOneProvider {
  readonly id: string;
  readonly defaultModel = "scripted";
  readonly requests: EvaluateRequest[] = [];
  #failures: number;
  readonly #script: Script;

  /** `failures` makes the first N calls fail as unreachable, for failover tests. */
  constructor(script: Script, id = "scripted", failures = 0) {
    this.#script = script;
    this.id = id;
    this.#failures = failures;
  }

  async evaluate(request: EvaluateRequest): Promise<Evaluation> {
    this.requests.push(request);
    if (this.#failures > 0) {
      this.#failures -= 1;
      throw new ProviderUnavailableError(`${this.id} is unreachable`);
    }
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions))
      answers[id] = answerFor(
        question,
        this.#script(request.batteryId ?? "", id, request.state),
      );
    return {
      answers,
      model: this.defaultModel,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      providerId: this.id,
      provenance: "scripted",
    };
  }
}
