import OpenAI from "openai";
import { ResultAsync, err, ok } from "neverthrow";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import { Errors, type BotError } from "../core/errors";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class OpenAIClient {
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    this.client = new OpenAI({ apiKey: config.openAIApiKey });
  }

  chat(options: { messages: ChatMessage[]; allowSearch?: boolean }) {
    const input: OpenAI.Responses.ResponseInput = options.messages.map((message) => ({
      role: message.role,
      content: [{ type: "input_text" as const, text: message.content }]
    }));
    const baseParams: { model: string; input: OpenAI.Responses.ResponseInput } = {
      model: "gpt-5.1",
      input
    };
    const params = options.allowSearch
      ? { ...baseParams, tools: [{ type: "web_search" as const }] }
      : baseParams;
    return ResultAsync.fromPromise(
      this.client.responses.create(params),
      (error) => {
        this.logger.error({ err: error }, "OpenAI chat failed");
        return Errors.openai(error instanceof Error ? error.message : "Unknown OpenAI error");
      }
    ).andThen((response) => {
      const text = this.extractText(response);
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
  }) {
    const input: OpenAI.Responses.ResponseInput = options.messages.map((message) => ({
      role: message.role,
      content: [{ type: "input_text" as const, text: message.content }]
    }));
    const format: OpenAI.Responses.ResponseFormatTextJSONSchemaConfig = {
      type: "json_schema",
      name: options.schemaName,
      schema: options.schema,
      strict: true
    };
    if (options.schemaDescription !== undefined) {
      format.description = options.schemaDescription;
    }
    const baseParams: {
      model: string;
      input: OpenAI.Responses.ResponseInput;
      text?: { format: OpenAI.Responses.ResponseFormatTextJSONSchemaConfig };
    } = {
      model: "gpt-5.1",
      input,
      text: { format }
    };
    const params = options.allowSearch
      ? { ...baseParams, tools: [{ type: "web_search" as const }] }
      : baseParams;
    return ResultAsync.fromPromise(
      this.client.responses.parse(params),
      (error) => {
        this.logger.error({ err: error }, "OpenAI structured chat failed");
        return Errors.openai(error instanceof Error ? error.message : "Unknown OpenAI error");
      }
    ).andThen((response) => {
      const parsedData = response.output_parsed as T | null;
      if (parsedData === null) {
        return err<never, BotError>(Errors.openai("OpenAI returned no structured data"));
      }
      return ok(parsedData);
    });
  }

  generateImage(options: { prompt: string }) {
    return ResultAsync.fromPromise(
      this.client.images.generate({
        model: "gpt-image-1",
        prompt: options.prompt,
        size: "1024x1024",
        quality: "high",
        response_format: "b64_json"
      }),
      (error) => {
        this.logger.error({ err: error }, "OpenAI image failed");
        return Errors.openai(error instanceof Error ? error.message : "Unknown OpenAI error");
      }
    ).andThen((response) => {
      const imageData = response.data![0]!.b64_json;
      if (!imageData) {
        return err<never, BotError>(Errors.openai("Image generation returned no data"));
      }
      const buffer = Buffer.from(imageData, "base64");
      return ok({ buffer, prompt: options.prompt });
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
