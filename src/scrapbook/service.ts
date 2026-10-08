import type { Logger } from "pino";
import type { ScrapbookStore, ScrapbookMemory, ContextMessage } from "./store";
import type { DecisionClient } from "../llm/decisions";

const CONTEXT_WINDOW_SIZE = 20;

interface MessageWithId {
  id: string;
  author: string;
  content: string;
  timestamp: number;
}

const NO_KEY_MESSAGE = "none";
const DETECTION_MAX_MESSAGES = 40;
const DETECTION_MIN_CONFIDENCE = 0.7;

export class ScrapbookService {
  private lastScrapbookTimestamp: number = 0;

  constructor(
    private readonly store: ScrapbookStore,
    private readonly decisions: DecisionClient,
    private readonly logger: Logger,
  ) {}

  async detectKeyMessage(messages: MessageWithId[]): Promise<string | null> {
    if (messages.length < 3) {
      return null;
    }

    const candidates = messages.slice(-DETECTION_MAX_MESSAGES);
    const messageList = candidates
      .map((m) => `[${m.id}] ${m.author}: ${m.content}`)
      .join("\n");

    const result = await this.decisions.decide(
      `Recent Discord chat messages, each prefixed with its ID:\n\n${messageList}`,
      [
        {
          type: "choice",
          name: "key_message",
          instructions: `Is any single message exceptionally memorable or quotable: genuinely hilarious, unexpectedly profound, or a memorable inside-joke moment worth reminiscing about later? Be very conservative; most conversations have nothing worth saving. Routine conversation, generic statements and bot messages never count. Pick its ID, or "${NO_KEY_MESSAGE}" if nothing stands out.`,
          choices: [
            { value: NO_KEY_MESSAGE, description: "Nothing stands out" },
            ...candidates.map((m) => ({
              value: m.id,
              description: `${m.author}: ${m.content.slice(0, 200)}`,
            })),
          ],
        },
      ],
    );

    if (result.isErr()) {
      this.logger.error(
        { err: result.error },
        "Failed to detect key message for scrapbook",
      );
      return null;
    }

    const answer = result.value.choice("key_message");
    if (
      !answer ||
      answer.value === NO_KEY_MESSAGE ||
      answer.confidence < DETECTION_MIN_CONFIDENCE
    ) {
      return null;
    }

    this.logger.info(
      { keyMessageId: answer.value, confidence: answer.confidence },
      "Detected memorable message for scrapbook",
    );
    return answer.value;
  }

  async saveMemory(
    keyMessage: MessageWithId,
    allMessages: MessageWithId[],
  ): Promise<string | null> {
    const keyIndex = allMessages.findIndex((m) => m.id === keyMessage.id);
    if (keyIndex === -1) {
      this.logger.warn(
        { keyMessageId: keyMessage.id },
        "Key message not found in message list",
      );
      return null;
    }

    if (
      this.lastScrapbookTimestamp > 0 &&
      keyMessage.timestamp - this.lastScrapbookTimestamp < 60000
    ) {
      this.logger.debug("Skipping scrapbook save - too soon after last save");
      return null;
    }

    const contextStart = Math.max(0, keyIndex - CONTEXT_WINDOW_SIZE / 2);
    const contextEnd = Math.min(
      allMessages.length - 1,
      keyIndex + CONTEXT_WINDOW_SIZE / 2,
    );

    const context: ContextMessage[] = [];
    for (let i = contextStart; i <= contextEnd; i++) {
      const message = allMessages[i];
      if (message) {
        context.push({
          author: message.author,
          content: message.content,
          timestamp: message.timestamp,
        });
      }
    }

    try {
      const memoryId = await this.store.insert({
        keyMessage: keyMessage.content,
        author: keyMessage.author,
        context,
        createdAt: new Date(),
      });

      this.lastScrapbookTimestamp = keyMessage.timestamp;
      this.logger.info(
        { memoryId, keyMessage: keyMessage.content, author: keyMessage.author },
        "Saved scrapbook memory",
      );

      return memoryId;
    } catch (error) {
      this.logger.error({ err: error }, "Failed to save scrapbook memory");
      return null;
    }
  }

  async getRandomMemory(): Promise<ScrapbookMemory | null> {
    try {
      return await this.store.getRandom();
    } catch (error) {
      this.logger.error(
        { err: error },
        "Failed to get random scrapbook memory",
      );
      return null;
    }
  }

  async searchMemories(
    query: string,
    limit: number = 10,
  ): Promise<ScrapbookMemory[]> {
    try {
      return await this.store.search(query, limit);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to search scrapbook memories");
      return [];
    }
  }

  async deleteMemory(id: string): Promise<boolean> {
    try {
      await this.store.delete(id);
      this.logger.info({ memoryId: id }, "Deleted scrapbook memory");
      return true;
    } catch (error) {
      this.logger.error(
        { err: error, memoryId: id },
        "Failed to delete scrapbook memory",
      );
      return false;
    }
  }

  async getMemoryById(id: string): Promise<ScrapbookMemory | null> {
    try {
      return await this.store.getById(id);
    } catch (error) {
      this.logger.error(
        { err: error, memoryId: id },
        "Failed to get scrapbook memory",
      );
      return null;
    }
  }

  async getMemoryByQuote(quote: string): Promise<ScrapbookMemory | null> {
    try {
      return await this.store.getByQuote(quote);
    } catch (error) {
      this.logger.error(
        { err: error, quote },
        "Failed to get scrapbook memory by quote",
      );
      return null;
    }
  }

  formatContext(memory: ScrapbookMemory): string {
    return memory.context.map((m) => `<${m.author}> ${m.content}`).join("\n");
  }
}
