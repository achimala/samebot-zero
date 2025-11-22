import type { Message } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

export class AutoReactFeature implements Feature {
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
    if (Math.random() > 0.15) {
      return;
    }
    const prompt = `You read Discord chat messages and react with up to 3 emojis.
Messages: "${message.author.displayName ?? message.author.username}: ${message.content}"
Respond with emojis separated by spaces only.`;
    const result = await this.ctx.openai.chat({
      messages: [
        { role: "system", content: "Respond only with emojis separated by spaces." },
        { role: "user", content: prompt }
      ]
    });
    await result.match(
      async (text) => {
        const emojis = text
          .split(/\s+/)
          .map((token) => token.trim())
          .filter(Boolean)
          .slice(0, 3);
        for (const emoji of emojis) {
          try {
            await message.react(emoji);
          } catch (error) {
            this.ctx.logger.warn({ err: error, emoji }, "Failed to react");
          }
        }
      },
      async () => {
        /* ignore errors */
      }
    );
  }
}
