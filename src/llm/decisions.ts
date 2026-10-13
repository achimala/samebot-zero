import { ResultAsync } from "neverthrow";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import { Errors, type BotError } from "../core/errors";

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DECISION_MODEL = "~typesafe/jev-latest";
const TIMEOUT_MS = 10_000;

/** Guidance for a question: a plain string, or structured JSON. */
type Guidance = string | Record<string, unknown> | unknown[];

/** A yes/no question. The answer is the probability that it's true. */
export interface NoulQuestion {
  type: "noul";
  instructions: Guidance;
  criteria?: { true: Guidance; false: Guidance };
}

/** Pick one option. Criteria maps each option label to guidance for it. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: Guidance;
  criteria: Record<string, Guidance | null>;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion;

type Answer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    };

interface DecisionsResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
}

/**
 * Typed view over a decisions response. Missing answers come back as null so
 * callers fall through to their conservative default.
 */
export class DecisionAnswers {
  constructor(private readonly answers: Record<string, Answer>) {}

  probability(name: string): number | null {
    const answer = this.answers[name];
    return answer?.type === "noul" ? answer.noul : null;
  }

  choice(name: string): { value: string; confidence: number } | null {
    const answer = this.answers[name];
    if (answer?.type !== "choice") {
      return null;
    }
    return { value: answer.choice, confidence: answer.confidence };
  }
}

/** Client for TypeSafe's Jev decision model via OpenRouter: fast, typed classification calls. */
export class DecisionClient {
  constructor(
    private readonly config: Pick<AppConfig, "openRouterApiKey">,
    private readonly logger: Logger,
  ) {}

  /**
   * Asks each question about `state`, the content to judge: a string, or a
   * JSON object when the context has several parts.
   */
  decide(
    state: string | Record<string, unknown>,
    questions: Record<string, DecisionQuestion>,
  ): ResultAsync<DecisionAnswers, BotError> {
    const startedAt = Date.now();
    return ResultAsync.fromPromise(
      this.request({ model: DECISION_MODEL, state, questions }),
      (error) => {
        this.logger.warn({ err: error }, "Decision request failed");
        return Errors.llm(
          error instanceof Error ? error.message : "Unknown decision error",
        );
      },
    ).map((response) => {
      this.logger.debug(
        { answers: response.answers, ms: Date.now() - startedAt },
        "Decision",
      );
      return new DecisionAnswers(response.answers);
    });
  }

  private async request(body: unknown): Promise<DecisionsResponse> {
    const response = await fetch(DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.openRouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Decisions API ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    return (await response.json()) as DecisionsResponse;
  }
}
