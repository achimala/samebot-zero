import type { Logger } from "pino";
import type { ScrapbookStore, ScrapbookMemory, ContextMessage } from "./store";
import type { OpenAIClient } from "../openai/client";

const CONTEXT_WINDOW_SIZE = 20;

interface MessageWithId {
  id: string;
  author: string;
  content: string;
  timestamp: number;
}

interface DetectionResult {
  keyMessageId: string | null;
}

export class ScrapbookService {
  private lastScrapbookTimestamp: number = 0;

  constructor(
    private readonly store: ScrapbookStore,
    private readonly openai: OpenAIClient,
    private readonly logger: Logger,
  ) {}

  async detectKeyMessage(messages: MessageWithId[]): Promise<string | null> {
    if (messages.length < 3) {
      return null;
    }

    const systemMessage = `You analyze chat conversations to identify exceptionally memorable or quotable moments.

Your task: Given a list of recent chat messages with IDs, determine if any single message stands out as particularly memorable, funny, profound, or quotable.

Be VERY conservative. Most conversations have nothing worth saving. Only identify a key message if it's genuinely:
- A hilarious or witty comment
- An unexpectedly profound statement
- A memorable inside joke moment
- Something that would be fun to reminisce about later

Return the message ID of the key message, or null if nothing stands out.
Do NOT select messages that are:
- Routine conversation
- Questions without interesting answers
- Generic statements
- Bot messages`;

    const messageList = messages
      .map((m) => `[${m.id}] ${m.author}: ${m.content}`)
      .join("\n");

    const result = await this.openai.chatStructured<DetectionResult>({
      messages: [
        { role: "system", content: systemMessage },
        {
          role: "user",
          content: `Analyze these messages and identify the most memorable one (if any):\n\n${messageList}`,
        },
      ],
      schema: {
        type: "object",
        properties: {
          keyMessageId: {
            type: ["string", "null"],
            description:
              "The ID of the most memorable message, or null if nothing stands out",
          },
        },
        required: ["keyMessageId"],
        additionalProperties: false,
      },
      schemaName: "scrapbookDetection",
      model: "gpt-5-mini",
    });

    if (!result.isOk()) {
      this.logger.error(
        { err: result.error },
        "Failed to detect key message for scrapbook",
      );
      return null;
    }

    const keyMessageId = result.value.keyMessageId;
    if (keyMessageId) {
      this.logger.info(
        { keyMessageId },
        "Detected memorable message for scrapbook",
      );
    }

    return keyMessageId;
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
