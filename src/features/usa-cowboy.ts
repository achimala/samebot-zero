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

    const response = await this.ctx.openai.chat({
      messages: [
        {
          role: "system",
          content:
            "Generate a unique ASCII art cowboy. Make it creative and varied each time. Include elements like a hat, boots, maybe a lasso or horse. Keep it compact enough to fit in a Discord message (under 2000 characters). Respond with only the ASCII art, nothing else.",
        },
        {
          role: "user",
          content: "Generate a unique ASCII art cowboy.",
        },
      ],
    });

    await response.match(
      async (cowboy) => {
        await this.ctx.messenger
          .replyToMessage(message, cowboy.trim())
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
        this.ctx.logger.warn(
          { err: error },
          "Failed to generate cowboy",
        );
      },
    );
  }
}
