import type { Message } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

export class DankResponseFeature implements Feature {
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
    if (!content.includes("dank")) {
      return;
    }

    const response = await this.ctx.openai.chat({
      messages: [
        {
          role: "system",
          content:
            "Generate a single creative portmanteau or variation of the word 'dank'. Examples: dankalicious, danktacular, danktastic. Respond with only the word, nothing else.",
        },
        {
          role: "user",
          content: "Generate a variation of 'dank'",
        },
      ],
    });

    await response.match(
      async (variation) => {
        await this.ctx.messenger
          .sendToChannel(message.channelId, variation.trim())
          .match(
            async () => undefined,
            async (error) => {
              this.ctx.logger.warn(
                { err: error },
                "Failed to send dank response",
              );
            },
          );
      },
      async (error) => {
        this.ctx.logger.warn(
          { err: error },
          "Failed to generate dank variation",
        );
      },
    );
  }
}
