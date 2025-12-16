import type { Logger } from "pino";
import type { OpenAIClient } from "../openai/client";

const APHORISM_CONVERSION_PROBABILITY = 0.05;

export async function shouldConvertToAphorism(
  message: string,
  context: string,
  openai: OpenAIClient,
  logger: Logger,
): Promise<boolean> {
  if (Math.random() >= APHORISM_CONVERSION_PROBABILITY) {
    return false;
  }

  const systemMessage = `You are determining whether a message would be appropriate to convert into a Confucian-style classical Chinese aphorism.

Convert to aphorism when:
- The message contains wisdom, advice, or philosophical insight
- The message expresses a universal truth or observation about life
- The message would sound natural and profound as an aphorism
- The conversion would add value rather than being forced or awkward

Do NOT convert when:
- The message is a question that needs a direct answer
- The message is technical, factual, or informational
- The message is a reaction, emoji, or very short response
- The message is clearly casual conversation that wouldn't benefit from aphoristic style
- The conversion would be forced, awkward, or inappropriate
- The message contains specific names, dates, or concrete details that would lose meaning

Be conservative - only return true if the conversion would genuinely enhance the message.`;

  const decision = await openai.chatStructured<{
    shouldConvert: boolean;
  }>({
    model: "gpt-5-mini",
    messages: [
      {
        role: "system",
        content: systemMessage,
      },
      {
        role: "user",
        content: `Conversation context:\n${context}\n\nMessage to evaluate:\n${message}\n\nShould this message be converted to a Confucian-style aphorism?`,
      },
    ],
    schema: {
      type: "object",
      properties: {
        shouldConvert: {
          type: "boolean",
          description:
            "Whether the message should be converted to a Confucian-style aphorism",
        },
      },
      required: ["shouldConvert"],
      additionalProperties: false,
    },
    schemaName: "aphorismConversionDecision",
    schemaDescription: "Decision on whether to convert message to aphorism",
  });

  return decision.match(
    (result) => {
      if (result.shouldConvert) {
        logger.debug({}, "Converting message to aphorism");
      }
      return result.shouldConvert;
    },
    (error) => {
      logger.warn({ err: error }, "Failed to check if should convert to aphorism");
      return false;
    },
  );
}

export async function convertToAphorism(
  message: string,
  context: string,
  openai: OpenAIClient,
  logger: Logger,
): Promise<string | null> {
  const systemMessage = `You are converting a message into the style of Confucian/classical Chinese aphorisms.

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
        content: `Conversation context:\n${context}\n\nOriginal message:\n${message}\n\nConvert this message to a Confucian-style aphorism:`,
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
