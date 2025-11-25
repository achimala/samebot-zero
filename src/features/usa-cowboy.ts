import type { Message } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

export class UsaCowboyFeature implements Feature {
  private ctx!: RuntimeContext;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || message.system || !message.inGuild()) {
      return;
    }

    const content = message.content.toLowerCase();
    if (!content.includes("usa")) {
      return;
    }

    if (!this.ctx.conversation) {
      return;
    }

    const response = await this.ctx.conversation.chatWithContext(
      message.channelId,
      {
        systemMessage:
          "Generate a unique ASCII art cowboy that is contextually relevant to the conversation. Make it creative and varied each time. Include elements like a hat, boots, maybe a lasso or horse. Keep it compact enough to fit in a Discord message (under 2000 characters). Use the conversation context to make the cowboy relevant to what's being discussed. Respond with only the ASCII art, nothing else.",
        userMessage:
          "Generate a contextually relevant ASCII art cowboy based on this conversation.",
      },
    );

    await response.match(
      async (cowboy) => {
        await this.ctx.messenger
          .replyToMessage(message, `\`\`\`\n${cowboy.trim()}\n\`\`\``)
          .match(
            async () => undefined,
            async (error) => {
              this.ctx.logger.warn(
                { err: error },
                "Failed to send cowboy response",
              );
            },
          );
      },
      async (error) => {
        this.ctx.logger.warn({ err: error }, "Failed to generate cowboy");
      },
    );
  }
}
