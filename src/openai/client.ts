import OpenAI, { toFile } from "openai";
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

const DEFAULT_IMAGE_CONFIG = {
  aspectRatio: "1:1" as const,
  imageSize: "1K" as const,
};

const CHAT_MODEL = "gpt-5.5";
const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 768;
const IMAGE_MODEL = "gpt-image-2";

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

const IMAGE_ASPECT_RATIOS: Record<ImageAspectRatio, [number, number]> = {
  "1:1": [1, 1],
  "2:3": [2, 3],
  "3:2": [3, 2],
  "3:4": [3, 4],
  "4:3": [4, 3],
  "9:16": [9, 16],
  "16:9": [16, 9],
  "21:9": [21, 9],
};

const IMAGE_SHORT_EDGE_BY_RESOLUTION: Record<ImageResolution, number> = {
  "1K": 1024,
  "2K": 2048,
  "4K": 3840,
};

const MAX_IMAGE_EDGE = 3840;
const MAX_IMAGE_PIXELS = 8_294_400;

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

  generateImage(options: {
    prompt: string;
    referenceImages?: Array<{ data: string; mimeType: string }>;
    aspectRatio?: ImageAspectRatio;
    imageSize?: ImageResolution;
  }) {
    return ResultAsync.fromPromise(
      this.createImage(options),
      (error) => {
        this.logger.error({ err: error }, "OpenAI image failed");
        return Errors.openai(
          error instanceof Error ? error.message : "Unknown OpenAI error",
        );
      },
    ).andThen((response) => {
      const imageData = response.data?.[0]?.b64_json;
      if (imageData) {
        const buffer = Buffer.from(imageData, "base64");
        return ok({ buffer, prompt: options.prompt });
      }
      return err<never, BotError>(
        Errors.openai("Image generation returned no data"),
      );
    });
  }

  private async createImage(options: {
    prompt: string;
    referenceImages?: Array<{ data: string; mimeType: string }>;
    aspectRatio?: ImageAspectRatio;
    imageSize?: ImageResolution;
  }): Promise<OpenAI.Images.ImagesResponse> {
    const size = this.resolveImageSize(
      options.aspectRatio ?? DEFAULT_IMAGE_CONFIG.aspectRatio,
      options.imageSize ?? DEFAULT_IMAGE_CONFIG.imageSize,
    );

    if (options.referenceImages && options.referenceImages.length > 0) {
      const imageFiles = await Promise.all(
        options.referenceImages.map((image, index) =>
          toFile(
            Buffer.from(image.data, "base64"),
            `reference-${index}.${this.extensionForMimeType(image.mimeType)}`,
            { type: image.mimeType },
          ),
        ),
      );

      return this.client.images.edit({
        model: IMAGE_MODEL,
        image: imageFiles,
        prompt: options.prompt,
        size,
      });
    }

    return this.client.images.generate({
      model: IMAGE_MODEL,
      prompt: options.prompt,
      size,
    });
  }

  private resolveImageSize(
    aspectRatio: ImageAspectRatio,
    imageSize: ImageResolution,
  ) {
    const [widthRatio, heightRatio] = IMAGE_ASPECT_RATIOS[aspectRatio];
    const targetEdge = IMAGE_SHORT_EDGE_BY_RESOLUTION[imageSize];
    const scale =
      imageSize === "4K"
        ? targetEdge / Math.max(widthRatio, heightRatio)
        : targetEdge / Math.min(widthRatio, heightRatio);

    return this.fitImageSize(widthRatio * scale, heightRatio * scale);
  }

  private fitImageSize(width: number, height: number) {
    const edgeScale = MAX_IMAGE_EDGE / Math.max(width, height);
    const pixelScale = Math.sqrt(MAX_IMAGE_PIXELS / (width * height));
    const scale = Math.min(1, edgeScale, pixelScale);
    const finalWidth = this.floorToImageMultiple(width * scale);
    const finalHeight = this.floorToImageMultiple(height * scale);
    return `${finalWidth}x${finalHeight}`;
  }

  private floorToImageMultiple(value: number) {
    return Math.floor(value / 16) * 16;
  }

  private extensionForMimeType(mimeType: string) {
    switch (mimeType) {
      case "image/jpeg":
        return "jpg";
      case "image/png":
        return "png";
      case "image/webp":
        return "webp";
      default:
        throw new Error(`Unsupported reference image MIME type: ${mimeType}`);
    }
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
