import type { Logger } from "pino";
import type { OpenAIClient } from "../openai/client";

const APHORISM_CONVERSION_PROBABILITY = 0.05;

export async function shouldConvertToAphorism(
  message: string,
  openai: OpenAIClient,
  logger: Logger,
): Promise<boolean> {
  if (Math.random() >= APHORISM_CONVERSION_PROBABILITY) {
    return false;
  }

  const systemMessage = `You are determining whether a user message is trivial or stupid (like "hi", "lol", "ok", etc.).

Return true if the message is trivial/stupid and should be skipped.
Return false if the message has substance and should be enhanced.`;

  const decision = await openai.chatStructured<{
    isTrivial: boolean;
  }>({
    model: "gpt-5-mini",
    messages: [
      {
        role: "system",
        content: systemMessage,
      },
      {
        role: "user",
        content: `Message to evaluate:\n${message}\n\nIs this message trivial or stupid?`,
      },
    ],
    schema: {
      type: "object",
      properties: {
        isTrivial: {
          type: "boolean",
          description: "Whether the message is trivial or stupid",
        },
      },
      required: ["isTrivial"],
      additionalProperties: false,
    },
    schemaName: "aphorismConversionDecision",
    schemaDescription: "Decision on whether message is trivial",
  });

  return decision.match(
    (result) => {
      const shouldEnhance = !result.isTrivial;
      if (shouldEnhance) {
        logger.debug({}, "Enhancing message to aphorism");
      }
      return shouldEnhance;
    },
    (error) => {
      logger.warn({ err: error }, "Failed to check if should convert to aphorism");
      return false;
    },
  );
}

export async function convertToAphorism(
  message: string,
  openai: OpenAIClient,
  logger: Logger,
): Promise<string | null> {
  const systemMessage = `You are converting a user message into the style of Confucian/classical Chinese aphorisms.

The style should:
- Use concise, poetic language
- Express universal truths or wisdom
- Sound like ancient Chinese philosophy (Confucius, Laozi, etc.)
- Be profound yet accessible
- Maintain the core meaning and intent of the original message
- Use classical aphoristic structures (e.g., "He who...", "The wise...", "In learning...")
- Be brief and memorable

Examples of the style:
- "He who seeks knowledge without wisdom finds only empty words."
- "The wise man learns from all, the fool from none."
- "In patience lies strength; in haste, only regret."
- "To understand others is wisdom; to understand oneself is enlightenment."

Convert the message while preserving its essential meaning and intent.`;

  const result = await openai.chat({
    messages: [
      {
        role: "system",
        content: systemMessage,
      },
      {
        role: "user",
        content: `Original message:\n${message}\n\nConvert this message to a Confucian-style aphorism:`,
      },
    ],
  });

  return result.match(
    (convertedMessage) => {
      logger.info(
        { original: message, converted: convertedMessage },
        "Converted message to aphorism",
      );
      return convertedMessage;
    },
    (error) => {
      logger.warn({ err: error }, "Failed to convert message to aphorism");
      return null;
    },
  );
}
