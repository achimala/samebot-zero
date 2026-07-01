import OpenAI from "openai";
import { ResultAsync, err, ok } from "neverthrow";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import { Errors, type BotError } from "../core/errors";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
};

export type ToolMessage = {
  role: "tool";
  toolCallId: string;
  content: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolStepResult =
  | { done: true; text: string }
  | { done: false; toolCalls: ToolCall[]; responseId: string };

const CHAT_MODEL = "gpt-5.5";
const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 768;

export class OpenAIClient {
  private readonly client: OpenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client = new OpenAI({ apiKey: config.openAIApiKey });
  }

  private formatMessageForInput(
    message: ChatMessage,
  ): OpenAI.Responses.ResponseInputItem {
    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string }
      | { type: "output_text"; text: string; annotations: never[] }
    > = [];

    if (message.role === "assistant") {
      content.push({
        type: "output_text" as const,
        text: message.content,
        annotations: [],
      });
      return {
        role: "assistant" as const,
        content: content,
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        status: "completed" as const,
      } as OpenAI.Responses.ResponseInputItem;
    }

    content.push({ type: "input_text" as const, text: message.content });

    if (message.images && message.images.length > 0) {
      for (const imageUrl of message.images) {
        content.push({
          type: "input_image" as const,
          image_url: imageUrl,
        });
      }
    }

    return {
      role: message.role,
      content: content,
    } as OpenAI.Responses.ResponseInputItem;
  }

  chat(options: { messages: ChatMessage[]; allowSearch?: boolean }) {
    const input: OpenAI.Responses.ResponseInput = options.messages.map(
      (message) => this.formatMessageForInput(message),
    );
    const baseParams: { model: string; input: OpenAI.Responses.ResponseInput } =
      {
        model: CHAT_MODEL,
        input,
      };
    const params = options.allowSearch
      ? { ...baseParams, tools: [{ type: "web_search" as const }] }
      : baseParams;
    this.logger.debug(
      {
        model: params.model,
        messages: options.messages,
        allowSearch: options.allowSearch,
      },
      "OpenAI chat input",
    );
    return ResultAsync.fromPromise(
      this.client.responses.create(params),
      (error) => {
        this.logger.error({ err: error }, "OpenAI chat failed");
        return Errors.openai(
          error instanceof Error ? error.message : "Unknown OpenAI error",
        );
      },
    ).andThen((response) => {
      const text = this.extractText(response);
      this.logger.debug(
        {
          model: params.model,
          response: text,
          rawResponse: response,
        },
        "OpenAI chat output",
      );
      if (!text) {
        return err<never, BotError>(Errors.openai("OpenAI returned no text"));
      }
      return ok(text.trim());
    });
  }

  chatStructured<T>(options: {
    messages: ChatMessage[];
    schema: { [key: string]: unknown };
    schemaName: string;
    schemaDescription?: string;
    allowSearch?: boolean;
    model?: string;
  }) {
    const input: OpenAI.Responses.ResponseInput = options.messages.map(
      (message) => this.formatMessageForInput(message),
    );
    const format: OpenAI.Responses.ResponseFormatTextJSONSchemaConfig = {
      type: "json_schema",
      name: options.schemaName,
      schema: options.schema,
      strict: true,
    };
    if (options.schemaDescription !== undefined) {
      format.description = options.schemaDescription;
    }
    const model = options.model ?? CHAT_MODEL;
    const baseParams: {
      model: string;
      input: OpenAI.Responses.ResponseInput;
      text?: { format: OpenAI.Responses.ResponseFormatTextJSONSchemaConfig };
    } = {
      model,
      input,
      text: { format },
    };
    const params = options.allowSearch
      ? { ...baseParams, tools: [{ type: "web_search" as const }] }
      : baseParams;
    this.logger.debug(
      {
        model: params.model,
        messages: options.messages,
        schema: options.schema,
        schemaName: options.schemaName,
        allowSearch: options.allowSearch,
      },
      "OpenAI structured chat input",
    );
    return ResultAsync.fromPromise(
      this.client.responses.parse(params),
      (error) => {
        this.logger.error({ err: error }, "OpenAI structured chat failed");
        return Errors.openai(
          error instanceof Error ? error.message : "Unknown OpenAI error",
        );
      },
    ).andThen((response) => {
      const parsedData = response.output_parsed as T | null;
      this.logger.debug(
        {
          model: params.model,
          parsedData,
          rawResponse: response,
        },
        "OpenAI structured chat output",
      );
      if (parsedData === null) {
        return err<never, BotError>(
          Errors.openai("OpenAI returned no structured data"),
        );
      }
      return ok(parsedData);
    });
  }

  chatWithToolsStep(options: {
    messages: Array<ChatMessage | ToolMessage>;
    tools: ToolDefinition[];
    allowSearch?: boolean;
    previousResponseId?: string;
  }) {
    const input: OpenAI.Responses.ResponseInput = options.messages.map(
      (message) => {
        if (message.role === "tool") {
          return {
            type: "function_call_output" as const,
            call_id: message.toolCallId,
            output: message.content,
          };
        }
        return this.formatMessageForInput(message);
      },
    );

    const tools: Array<
      | { type: "web_search" }
      | {
          type: "function";
          name: string;
          description: string;
          parameters: Record<string, unknown>;
          strict: boolean;
        }
    > = options.tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    }));

    if (options.allowSearch) {
      tools.push({ type: "web_search" as const });
    }

    const params: {
      model: string;
      input: OpenAI.Responses.ResponseInput;
      tools: typeof tools;
      previous_response_id?: string;
    } = {
      model: CHAT_MODEL,
      input,
      tools,
    };

    if (options.previousResponseId) {
      params.previous_response_id = options.previousResponseId;
    }

    this.logger.debug(
      {
        model: params.model,
        messageCount: options.messages.length,
        tools: options.tools.map((t) => t.name),
        allowSearch: options.allowSearch,
        previousResponseId: options.previousResponseId,
      },
      "OpenAI tool step input",
    );

    return ResultAsync.fromPromise(
      this.client.responses.create(
        params,
      ) as Promise<OpenAI.Responses.Response>,
      (error) => {
        this.logger.error({ err: error }, "OpenAI tool step failed");
        return Errors.openai(
          error instanceof Error ? error.message : "Unknown OpenAI error",
        );
      },
    ).andThen((response) => {
      const result = this.parseToolStepResponse(response);
      this.logger.debug(
        {
          model: params.model,
          result,
          rawResponse: response,
        },
        "OpenAI tool step output",
      );
      return ok(result);
    });
  }

  private parseToolStepResponse(
    response: OpenAI.Responses.Response,
  ): ToolStepResult {
    const toolCalls: ToolCall[] = [];
    const textChunks: string[] = [];

    for (const entry of response.output) {
      if (entry.type === "function_call") {
        toolCalls.push({
          id: entry.call_id,
          name: entry.name,
          arguments: JSON.parse(entry.arguments) as Record<string, unknown>,
        });
      } else if (entry.type === "message") {
        for (const content of entry.content) {
          if (content.type === "output_text") {
            textChunks.push(content.text);
          }
        }
      }
    }

    if (toolCalls.length > 0) {
      return { done: false, toolCalls, responseId: response.id };
    }

    const text = textChunks.join("\n").trim();
    return { done: true, text };
  }

  generateEmbedding(text: string) {
    return ResultAsync.fromPromise(
      this.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      }),
      (error) => {
        this.logger.error({ err: error }, "OpenAI embedding failed");
        return Errors.openai(
          error instanceof Error ? error.message : "Unknown OpenAI error",
        );
      },
    ).andThen((response) => {
      const embedding = response.data[0]?.embedding;
      if (!embedding || embedding.length === 0) {
        return err<never, BotError>(
          Errors.openai("Embedding generation returned no data"),
        );
      }
      return ok(embedding);
    });
  }

  private extractText(response: OpenAI.Responses.Response) {
    const chunks: string[] = [];
    for (const entry of response.output) {
      if (entry.type === "message") {
        for (const content of entry.content) {
          if (content.type === "output_text") {
            chunks.push(content.text);
          }
        }
      }
    }
    const combined = chunks.join("\n").trim();
    if (combined.length > 0) {
      return combined;
    }
    return null;
  }
}
