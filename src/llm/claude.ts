import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { ResultAsync, err, ok } from "neverthrow";
import type { Logger } from "pino";
import type { z } from "zod";
import type { AppConfig } from "../core/config";
import { Errors, type BotError } from "../core/errors";

export const MODELS = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
} as const;

export type ModelTier = keyof typeof MODELS;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  /** Image data URIs or http(s) URLs. */
  images?: string[];
};

export const WEB_SEARCH_TOOL: BetaToolUnion = {
  type: "web_search_20260318",
  name: "web_search",
  max_uses: 3,
};

const DEFAULT_MAX_TOKENS = 1024;

export type Effort = "low" | "medium" | "high";

/**
 * Latency settings per tier. Sonnet skips up-front thinking (it still writes
 * short notes between tool calls); Haiku doesn't think by default. Opus is
 * used for offline creative work and keeps its default thinking.
 */
function speedParams(tier: ModelTier, effort: Effort = "low") {
  switch (tier) {
    case "opus":
      return {};
    case "haiku":
      return { output_config: { effort } };
    case "sonnet":
      return {
        thinking: { type: "between_tools" as const },
        output_config: { effort },
      };
  }
}

export class ClaudeClient {
  private readonly client: Anthropic;

  constructor(
    config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2 });
  }

  /** Plain text completion. System-role messages are hoisted into `system`. */
  chat(options: {
    messages: ChatMessage[];
    model?: ModelTier;
    webSearch?: boolean;
    preserveWhitespace?: boolean;
    maxTokens?: number;
  }): ResultAsync<string, BotError> {
    const { system, messages } = toMessageParams(options.messages);
    const tier = options.model ?? "sonnet";
    const request = this.client.beta.messages.toolRunner({
      model: MODELS[tier],
      ...speedParams(tier),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      messages,
      tools: options.webSearch ? [WEB_SEARCH_TOOL] : [],
      max_iterations: 4,
    });

    return ResultAsync.fromPromise(request.runUntilDone(), (error) =>
      this.toError("chat", error),
    ).andThen((message) => {
      const text = extractText(message);
      if (!text.trim()) {
        return err<never, BotError>(Errors.llm("Claude returned no text"));
      }
      return ok(options.preserveWhitespace ? text : text.trim());
    });
  }

  /** Structured output validated against a zod schema. */
  chatStructured<S extends z.ZodType>(options: {
    messages: ChatMessage[];
    schema: S;
    model?: ModelTier;
    maxTokens?: number;
  }): ResultAsync<z.infer<S>, BotError> {
    const { system, messages } = toMessageParams(options.messages);
    const tier = options.model ?? "haiku";
    const request = this.client.beta.messages.parse({
      model: MODELS[tier],
      ...speedParams(tier),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      messages,
      output_format: betaZodOutputFormat(options.schema),
    });

    return ResultAsync.fromPromise(request, (error) =>
      this.toError("structured chat", error),
    ).andThen((message) => {
      const parsed = message.parsed_output as z.infer<S> | null | undefined;
      if (parsed === null || parsed === undefined) {
        return err<z.infer<S>, BotError>(
          Errors.llm("Claude returned no structured output"),
        );
      }
      return ok<z.infer<S>, BotError>(parsed);
    });
  }

  /**
   * Runs a full tool-use loop with the SDK tool runner and returns the final
   * assistant text. Client tools execute via their `run` callbacks.
   */
  runAgent(options: {
    system: BetaTextBlockParam[];
    messages: BetaMessageParam[];
    tools: Array<BetaRunnableTool | BetaToolUnion>;
    model?: ModelTier;
    effort?: Effort;
    maxIterations?: number;
    maxTokens?: number;
  }): ResultAsync<string, BotError> {
    const tier = options.model ?? "sonnet";
    const runner = this.client.beta.messages.toolRunner({
      model: MODELS[tier],
      ...speedParams(tier, options.effort),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      max_iterations: options.maxIterations ?? 8,
    });

    return ResultAsync.fromPromise(runner.runUntilDone(), (error) =>
      this.toError("agent run", error),
    ).map((message) => extractText(message).trim());
  }

  private toError(operation: string, error: unknown): BotError {
    this.logger.error({ err: error }, `Claude ${operation} failed`);
    return Errors.llm(
      error instanceof Error ? error.message : "Unknown Claude error",
    );
  }
}

export function extractText(message: BetaMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function imageBlock(image: string): BetaContentBlockParam | null {
  const dataUri = image.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUri?.[1] && dataUri[2]) {
    const mediaType = dataUri[1];
    if (
      mediaType !== "image/jpeg" &&
      mediaType !== "image/png" &&
      mediaType !== "image/gif" &&
      mediaType !== "image/webp"
    ) {
      return null;
    }
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: dataUri[2] },
    };
  }
  if (/^https?:\/\//.test(image)) {
    return { type: "image", source: { type: "url", url: image } };
  }
  return null;
}

/**
 * Converts role-tagged chat messages into Messages API params: system
 * messages are hoisted, consecutive same-role turns are merged, and the
 * conversation is guaranteed to start and end on a user turn.
 */
export function toMessageParams(input: ChatMessage[]): {
  system: string;
  messages: BetaMessageParam[];
} {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: BetaContentBlockParam[] }> = [];

  for (const message of input) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    const blocks: BetaContentBlockParam[] = [];
    if (message.content.length > 0) {
      blocks.push({ type: "text", text: message.content });
    }
    if (message.role === "user") {
      for (const image of message.images ?? []) {
        const block = imageBlock(image);
        if (block) {
          blocks.push(block);
        }
      }
    }
    if (blocks.length === 0) {
      continue;
    }
    const previous = messages[messages.length - 1];
    if (previous && previous.role === message.role) {
      previous.content.push(...blocks);
    } else {
      messages.push({ role: message.role, content: blocks });
    }
  }

  if (messages[0]?.role !== "user") {
    messages.unshift({
      role: "user",
      content: [{ type: "text", text: "(conversation start)" }],
    });
  }
  if (messages[messages.length - 1]?.role !== "user") {
    messages.push({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }

  return { system: systemParts.join("\n\n"), messages };
}
