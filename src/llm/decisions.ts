import OpenAI from "openai";
import type {
  Decision,
  DecisionCreateParams,
} from "openai/resources/decisions";
import { ResultAsync } from "neverthrow";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import { Errors, type BotError } from "../core/errors";

const DECISION_MODEL = "gpt-6-luna";

export type DecisionQuestion = DecisionCreateParams["questions"][number];

/**
 * Typed view over a Decisions API response. Refused or missing answers come
 * back as null so callers fall through to their conservative default.
 */
export class DecisionAnswers {
  constructor(private readonly decision: Decision) {}

  probability(name: string): number | null {
    const answer = this.find(name);
    return answer?.type === "predicate" ? answer.probability : null;
  }

  choice(name: string): { value: string; confidence: number } | null {
    const answer = this.find(name);
    if (answer?.type !== "choice") {
      return null;
    }
    return { value: String(answer.choice), confidence: answer.confidence };
  }

  private find(name: string) {
    return this.decision.answers.find((answer) => answer.name === name);
  }
}

/** Client for OpenAI's Decisions API: fast, typed classification calls. */
export class DecisionClient {
  private readonly client: OpenAI;

  constructor(
    config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client = new OpenAI({
      apiKey: config.openAIApiKey,
      timeout: 10_000,
      maxRetries: 1,
    });
  }

  decide(
    input: string,
    questions: DecisionQuestion[],
  ): ResultAsync<DecisionAnswers, BotError> {
    const startedAt = Date.now();
    return ResultAsync.fromPromise(
      this.client.decisions.create({
        model: DECISION_MODEL,
        input,
        questions,
      }),
      (error) => {
        this.logger.warn({ err: error }, "Decision request failed");
        return Errors.llm(
          error instanceof Error ? error.message : "Unknown decision error",
        );
      },
    ).map((decision) => {
      this.logger.debug(
        { answers: decision.answers, ms: Date.now() - startedAt },
        "Decision",
      );
      return new DecisionAnswers(decision);
    });
  }
}
