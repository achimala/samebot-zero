import type { Logger } from "pino";
import type { ClaudeClient } from "../llm/claude";
import type { DecisionClient } from "../llm/decisions";

const APHORISM_CONVERSION_PROBABILITY = 0.02;
const APHORISM_CONVERSION_PROBABILITY_ALL_CAPS = 0.2;

function isAllCaps(message: string): boolean {
  const trimmedMessage = message.trim();
  if (trimmedMessage.length === 0) {
    return false;
  }
  const hasLetters = /[a-zA-Z]/.test(trimmedMessage);
  if (!hasLetters) {
    return false;
  }
  return trimmedMessage === trimmedMessage.toUpperCase() && trimmedMessage !== trimmedMessage.toLowerCase();
}

export async function shouldConvertToAphorism(
  message: string,
  decisions: DecisionClient,
  logger: Logger,
): Promise<boolean> {
  const allCaps = isAllCaps(message);
  const probability = allCaps ? APHORISM_CONVERSION_PROBABILITY_ALL_CAPS : APHORISM_CONVERSION_PROBABILITY;

  if (Math.random() >= probability) {
    return false;
  }

  const decision = await decisions.decide(`Chat message: ${message}`, [
    {
      type: "predicate",
      name: "has_substance",
      instructions:
        "Does this chat message have real substance (an idea, opinion, or statement), as opposed to being trivial filler like 'hi', 'lol', or 'ok'?",
    },
  ]);

  return decision.match(
    (answers) => {
      const shouldEnhance = (answers.probability("has_substance") ?? 0) >= 0.5;
      if (shouldEnhance) {
        logger.debug({}, "Enhancing message to aphorism");
      }
      return shouldEnhance;
    },
    () => false,
  );
}

export async function convertToAphorism(
  message: string,
  llm: ClaudeClient,
  logger: Logger,
): Promise<string | null> {
  const allCaps = isAllCaps(message);
  
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

  const result = await llm.chat({
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
      const finalMessage = allCaps ? convertedMessage.toUpperCase() : convertedMessage;
      logger.info(
        { original: message, converted: finalMessage },
        "Converted message to aphorism",
      );
      return finalMessage;
    },
    (error) => {
      logger.warn({ err: error }, "Failed to convert message to aphorism");
      return null;
    },
  );
}
