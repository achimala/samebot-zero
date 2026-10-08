import { GoogleGenAI, type Interactions } from "@google/genai";
import { ResultAsync, err, ok } from "neverthrow";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import { Errors, type BotError } from "../core/errors";
import { augmentPromptForReferenceImages } from "../utils/reference-image-prompt";

/**
 * "fast" (~6s) is for interactive requests where someone is waiting;
 * "best" (~16s) is for scheduled posts where quality matters more.
 */
const IMAGE_MODELS = {
  fast: "gemini-3.1-flash-lite-image",
  best: "gemini-nano-banana-2.1",
} as const;
const VIDEO_MODEL = "gemini-omni-1.1-flash";

type InteractionInput = string | Array<Interactions.TextContent | Interactions.ImageContent>;
type VideoInteraction = {
  id: string;
  status: string;
  output_video?: { data?: string | undefined; uri?: string | undefined } | undefined;
};

const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_MAX_ATTEMPTS = 120;

export type ImageAspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "9:16"
  | "16:9"
  | "21:9";

export type ImageResolution = "1K" | "2K" | "4K";

export type GenerateImageOptions = {
  prompt: string;
  referenceImages?: Array<{ data: string; mimeType: string }>;
  baseImageCount?: number;
  aspectRatio?: ImageAspectRatio;
  imageSize?: ImageResolution;
  quality?: keyof typeof IMAGE_MODELS;
};

export type GenerateGifOptions = {
  prompt: string;
  referenceImages?: Array<{ data: string; mimeType: string }>;
  aspectRatio?: "16:9" | "9:16";
};

export class GeminiClient {
  private readonly client: GoogleGenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client = new GoogleGenAI({ apiKey: config.googleApiKey });
  }

  generateImage(options: GenerateImageOptions) {
    return ResultAsync.fromPromise(
      this.createImage(options),
      (error) => {
        this.logger.error({ err: error }, "Gemini image generation failed");
        return Errors.gemini(
          error instanceof Error ? error.message : "Unknown Gemini error",
        );
      },
    ).andThen((buffer) => {
      if (buffer) {
        return ok({ buffer, prompt: options.prompt });
      }
      return err<never, BotError>(
        Errors.gemini("Image generation returned no data"),
      );
    });
  }

  generateVideo(options: GenerateGifOptions) {
    return ResultAsync.fromPromise(
      this.createVideo(options),
      (error) => {
        this.logger.error({ err: error }, "Gemini video generation failed");
        return Errors.gemini(
          error instanceof Error ? error.message : "Unknown Gemini error",
        );
      },
    ).andThen((buffer) => {
      if (buffer) {
        return ok({ buffer, prompt: options.prompt });
      }
      return err<never, BotError>(
        Errors.gemini("Video generation returned no data"),
      );
    });
  }

  private async createImage(options: GenerateImageOptions): Promise<Buffer | null> {
    const aspectRatio = options.aspectRatio ?? "1:1";
    const prompt = this.buildImagePrompt(options);

    const interaction = await this.client.interactions.create({
      model: IMAGE_MODELS[options.quality ?? "fast"],
      input: prompt,
      response_format: {
        type: "image",
        aspect_ratio: aspectRatio,
        image_size: options.imageSize ?? "1K",
      },
    });

    return this.extractImageBuffer(interaction.output_image);
  }

  private buildImagePrompt(options: GenerateImageOptions): InteractionInput {
    if (!options.referenceImages || options.referenceImages.length === 0) {
      return options.prompt;
    }

    const prompt = augmentPromptForReferenceImages(
      options.prompt,
      options.referenceImages.length,
      options.baseImageCount ?? 0,
    );

    const input: Array<Interactions.TextContent | Interactions.ImageContent> = [
      { type: "text", text: prompt },
    ];

    for (const referenceImage of options.referenceImages) {
      input.push({
        type: "image",
        data: referenceImage.data,
        mime_type: referenceImage.mimeType,
      });
    }

    return input;
  }

  private async createVideo(options: GenerateGifOptions): Promise<Buffer | null> {
    const aspectRatio = options.aspectRatio ?? "16:9";
    const referenceImageCount = options.referenceImages?.length ?? 0;

    const input = this.buildVideoInput(options.prompt, options.referenceImages);

    const interaction = await this.client.interactions.create({
      model: VIDEO_MODEL,
      input,
      response_format: {
        type: "video",
        aspect_ratio: aspectRatio,
      },
      ...(referenceImageCount > 0 && {
        generation_config: {
          video_config: {
            task:
              referenceImageCount === 1
                ? "image_to_video"
                : "reference_to_video",
          },
        },
      }),
    });

    const completedInteraction = await this.waitForCompletedInteraction(
      interaction as VideoInteraction,
    );
    return this.extractVideoBuffer(completedInteraction);
  }

  private buildVideoInput(
    prompt: string,
    referenceImages?: Array<{ data: string; mimeType: string }>,
  ): InteractionInput {
    if (!referenceImages || referenceImages.length === 0) {
      return prompt;
    }

    const input: Array<Interactions.TextContent | Interactions.ImageContent> = [];

    for (const referenceImage of referenceImages) {
      input.push({
        type: "image",
        data: referenceImage.data,
        mime_type: referenceImage.mimeType,
      });
    }

    input.push({ type: "text", text: prompt });
    return input;
  }

  private async waitForCompletedInteraction(interaction: VideoInteraction) {
    let currentInteraction = interaction;

    for (
      let attempt = 0;
      attempt < VIDEO_POLL_MAX_ATTEMPTS &&
      currentInteraction.status === "in_progress";
      attempt++
    ) {
      await new Promise((resolve) => {
        setTimeout(resolve, VIDEO_POLL_INTERVAL_MS);
      });
      currentInteraction = (await this.client.interactions.get(
        currentInteraction.id,
      )) as VideoInteraction;
    }

    if (currentInteraction.status !== "completed") {
      throw new Error(
        `Video generation ended with status: ${currentInteraction.status}`,
      );
    }

    return currentInteraction;
  }

  private extractImageBuffer(
    outputImage: { data?: string | undefined } | undefined,
  ): Buffer | null {
    if (!outputImage?.data) {
      return null;
    }
    return Buffer.from(outputImage.data, "base64");
  }

  private async extractVideoBuffer(
    interaction: VideoInteraction,
  ): Promise<Buffer | null> {
    const outputVideo = interaction.output_video;

    if (outputVideo?.data) {
      return Buffer.from(outputVideo.data, "base64");
    }

    if (outputVideo?.uri) {
      const response = await fetch(outputVideo.uri, {
        headers: {
          "x-goog-api-key": this.config.googleApiKey,
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to download generated video: ${response.status} ${response.statusText}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    return null;
  }
}
