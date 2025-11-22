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
    return ResultAsync.fromPromise(
      this.client.responses.create({
        model: "gpt-5.1",
        input: options.messages.map((message) => ({
          role: message.role,
          content: [{ type: "input_text", text: message.content }]
        })),
        tools: options.allowSearch ? [{ type: "web_search" }] : undefined
      }),
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
      const imageData = response.data?.[0]?.b64_json;
      if (!imageData) {
        return err<never, BotError>(Errors.openai("Image generation returned no data"));
      }
      const buffer = Buffer.from(imageData, "base64");
      return ok({ buffer, prompt: options.prompt });
    });
  }

  private extractText(response: OpenAI.Responses.Response) {
    if (response.output) {
      const chunks = response.output
        .flatMap((entry) => entry.content ?? [])
        .filter((content) => content.type === "output_text")
        .map((content) => (content.type === "output_text" ? content.text : ""));
      const combined = chunks.join("\n").trim();
      if (combined.length > 0) {
        return combined;
      }
    }

    // Fallback for future API changes
    if ("output_text" in response && Array.isArray((response as any).output_text)) {
      const text = ((response as any).output_text as string[]).join("\n").trim();
      if (text.length > 0) {
        return text;
      }
    }

    return null;
  }
}
