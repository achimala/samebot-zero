import type { OpenAIClient } from "../openai/client";
import type { Logger } from "pino";
import { EntityResolver } from "./entity-resolver";
import { SCRAPBOOK_IMAGE_PROMPT_SYSTEM } from "./image-prompt-instructions";

export interface ScrapbookMemoryForImagePrompt {
  keyMessage: string;
  author: string;
  context: Array<{ author: string; content: string }>;
}

export async function generateScrapbookImagePrompt(
  openai: OpenAIClient,
  entityResolver: EntityResolver,
  memory: ScrapbookMemoryForImagePrompt,
  logger: Logger,
): Promise<{
  textPrompt: string;
  referenceImages?: Array<{ data: string; mimeType: string }>;
} | null> {
  const contextText = memory.context
    .map((message) => `<${message.author}> ${message.content}`)
    .join("\n");

  const userPrompt = `Write an image prompt inspired by this conversation moment:

Conversation context:
${contextText}

Key quote: "${memory.keyMessage}" - ${memory.author}`;

  const result = await openai.chatStructured<{ prompt: string }>({
    messages: [
      {
        role: "system",
        content: SCRAPBOOK_IMAGE_PROMPT_SYSTEM,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The image generation prompt",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    schemaName: "imagePrompt",
    model: "gpt-5.4-mini",
  });

  if (!result.isOk()) {
    logger.warn(
      { err: result.error },
      "Failed to generate image prompt for scrapbook memory",
    );
    return null;
  }

  let textPrompt = result.value.prompt;
  let referenceImages: Array<{ data: string; mimeType: string }> | undefined;

  const entityResolution = await entityResolver.resolve(textPrompt);
  if (entityResolution) {
    const built = entityResolver.buildPromptWithReferences(entityResolution);
    textPrompt = built.textPrompt;
    referenceImages = built.referenceImages;
  }

  return {
    textPrompt,
    referenceImages,
  };
}
