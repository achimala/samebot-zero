import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { ResultAsync, err, ok } from "neverthrow";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import { Errors, type BotError } from "../core/errors";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
};

const DEFAULT_IMAGE_CONFIG = {
  aspectRatio: "1:1" as const,
  imageSize: "1K" as const,
};

type ImageAspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "9:16"
  | "16:9"
  | "21:9";

type ImageResolution = "1K" | "2K" | "4K";

export class OpenAIClient {
  private readonly client: OpenAI;
  private readonly geminiClient: GoogleGenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client = new OpenAI({ apiKey: config.openAIApiKey });
    this.geminiClient = new GoogleGenAI({ apiKey: config.googleApiKey });
  }

  private formatMessageForInput(
    message: ChatMessage,
  ): OpenAI.Responses.ResponseInputItem {
    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image_url"; image_url: { url: string } }
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
        content: content as OpenAI.Responses.ResponseInputItem["content"],
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        status: "completed" as const,
      };
    }

    content.push({ type: "input_text" as const, text: message.content });

    if (message.images && message.images.length > 0) {
      for (const imageUrl of message.images) {
        content.push({
          type: "input_image_url" as const,
          image_url: { url: imageUrl },
        });
      }
    }

    return {
      role: message.role,
      content: content as OpenAI.Responses.ResponseInputItem["content"],
    };
  }

  chat(options: { messages: ChatMessage[]; allowSearch?: boolean }) {
    const input: OpenAI.Responses.ResponseInput = options.messages.map(
      (message) => this.formatMessageForInput(message),
    );
    const baseParams: { model: string; input: OpenAI.Responses.ResponseInput } =
      {
        model: "gpt-5.1",
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
    const model = options.model ?? "gpt-5.1";
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

  generateImage(options: {
    prompt: string;
    aspectRatio?: ImageAspectRatio;
    imageSize?: ImageResolution;
  }) {
    const imageConfig = {
      aspectRatio: options.aspectRatio ?? DEFAULT_IMAGE_CONFIG.aspectRatio,
      imageSize: options.imageSize ?? DEFAULT_IMAGE_CONFIG.imageSize,
    };

    return ResultAsync.fromPromise(
      this.geminiClient.models.generateContent({
        model: "gemini-3-pro-image-preview",
        contents: options.prompt,
        config: {
          responseModalities: ["IMAGE"],
          imageConfig,
        },
      }),
      (error) => {
        this.logger.error({ err: error }, "Gemini image failed");
        return Errors.openai(
          error instanceof Error ? error.message : "Unknown Gemini error",
        );
      },
    ).andThen((response) => {
      const candidates = response.candidates ?? [];
      for (const candidate of candidates) {
        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
          const inlineData = part.inlineData;
          if (
            part.thought ||
            !inlineData?.data ||
            !inlineData.mimeType?.startsWith("image/")
          ) {
            continue;
          }
          const buffer = Buffer.from(inlineData.data, "base64");
          return ok({ buffer, prompt: options.prompt });
        }
      }
      return err<never, BotError>(
        Errors.openai("Image generation returned no data"),
      );
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
