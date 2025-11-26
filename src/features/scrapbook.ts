import type { Message } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import type { ScrapbookMemory } from "../scrapbook/store";

const INACTIVITY_TIMEOUT_MS = 90 * 60 * 1000;
const SCRAPBOOK_EXTRACTION_INTERVAL = 6;

interface ChannelState {
  lastActivityAt: number;
  messagesSinceLastExtraction: number;
  hasSentConversationStarter: boolean;
}

export class ScrapbookFeature implements Feature {
  private ctx!: RuntimeContext;
  private channelStates = new Map<string, ChannelState>();
  private inactivityTimer: NodeJS.Timeout | null = null;

  register(context: RuntimeContext): void {
    this.ctx = context;

    context.discord.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });

    context.discord.once("ready", () => {
      this.startInactivityTimer();
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || message.system) {
      return;
    }

    const channelId = message.channelId;
    const isMainChannel = channelId === this.ctx.config.mainChannelId;

    if (!isMainChannel) {
      return;
    }

    let state = this.channelStates.get(channelId);
    if (!state) {
      state = {
        lastActivityAt: Date.now(),
        messagesSinceLastExtraction: 0,
        hasSentConversationStarter: false,
      };
      this.channelStates.set(channelId, state);
    }

    state.lastActivityAt = Date.now();
    state.hasSentConversationStarter = false;
    state.messagesSinceLastExtraction++;

    if (state.messagesSinceLastExtraction >= SCRAPBOOK_EXTRACTION_INTERVAL) {
      await this.runScrapbookDetection(channelId);
      state.messagesSinceLastExtraction = 0;
    }
  }

  private async runScrapbookDetection(channelId: string): Promise<void> {
    const conversationContext = this.ctx.conversation?.getContext(channelId);
    if (!conversationContext || conversationContext.history.length < 3) {
      return;
    }

    const messages: Array<{
      id: string;
      author: string;
      content: string;
      timestamp: number;
    }> = [];

    for (const m of conversationContext.history) {
      if (m.role !== "user") {
        continue;
      }
      const authorMatch = m.content.match(/^([^:]+): (.+)$/);
      const author = authorMatch?.[1] ?? "unknown";
      const content = authorMatch?.[2] ?? m.content;
      messages.push({
        id: m.id,
        author,
        content,
        timestamp: m.timestamp,
      });
    }

    const keyMessageId = await this.ctx.scrapbook.detectKeyMessage(messages);
    if (!keyMessageId) {
      return;
    }

    const keyMessage = messages.find((m) => m.id === keyMessageId);
    if (!keyMessage) {
      this.ctx.logger.warn(
        { keyMessageId },
        "Key message ID not found in messages",
      );
      return;
    }

    await this.ctx.scrapbook.saveMemory(keyMessage, messages);
  }

  private startInactivityTimer(): void {
    this.inactivityTimer = setInterval(() => {
      void this.checkInactivity();
    }, 60000);
  }

  private async checkInactivity(): Promise<void> {
    const mainChannelId = this.ctx.config.mainChannelId;
    const state = this.channelStates.get(mainChannelId);

    if (!state) {
      return;
    }

    if (state.hasSentConversationStarter) {
      return;
    }

    const timeSinceActivity = Date.now() - state.lastActivityAt;
    if (timeSinceActivity < INACTIVITY_TIMEOUT_MS) {
      return;
    }

    await this.sendConversationStarter(mainChannelId, state);
  }

  private async sendConversationStarter(
    channelId: string,
    state: ChannelState,
  ): Promise<void> {
    const memory = await this.ctx.scrapbook.getRandomMemory();
    if (!memory) {
      return;
    }

    state.hasSentConversationStarter = true;

    const formattedMemory = this.formatScrapbookMemory(memory);

    const imagePrompt = await this.generateImagePromptForMemory(memory);
    if (imagePrompt) {
      const imageResult = await this.ctx.openai.generateImage({
        prompt: imagePrompt,
        aspectRatio: "16:9",
      });

      await imageResult.match(
        async ({ buffer }) => {
          await this.ctx.messenger.sendBuffer(
            channelId,
            buffer,
            "scrapbook-memory.png",
            formattedMemory,
          );
        },
        async (error) => {
          this.ctx.logger.warn(
            { err: error },
            "Failed to generate scrapbook image, sending text only",
          );
          await this.ctx.messenger.sendToChannel(
            channelId,
            formattedMemory,
          );
        },
      );
    } else {
      await this.ctx.messenger.sendToChannel(
        channelId,
        formattedMemory,
      );
    }
  }

  private formatScrapbookMemory(memory: ScrapbookMemory): string {
    return `> "${memory.keyMessage}"\n> — ${memory.author}`;
  }

  private async generateImagePromptForMemory(
    memory: ScrapbookMemory,
  ): Promise<string | null> {
    const result = await this.ctx.openai.chatStructured<{ prompt: string }>({
      messages: [
        {
          role: "system",
          content: `You create artistic image prompts for nostalgic chat memories.
Given a memorable chat quote, create a creative, whimsical image prompt that captures the essence or humor of the moment.
The image should be surreal, artistic, and evocative - not a literal depiction.
Keep the prompt concise (under 100 words).`,
        },
        {
          role: "user",
          content: `Create an image prompt for this memory:\n"${memory.keyMessage}" - ${memory.author}`,
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
      model: "gpt-5-mini",
    });

    if (result.isOk()) {
      return result.value.prompt;
    }

    this.ctx.logger.warn(
      { err: result.error },
      "Failed to generate image prompt for scrapbook memory",
    );
    return null;
  }
}
