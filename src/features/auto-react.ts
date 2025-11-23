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

  private buildEmojiList(): string {
    const emojiList: string[] = [];
    for (const emoji of this.ctx.customEmoji.values()) {
      const format = emoji.animated
        ? `<a:${emoji.name}:${emoji.id}>`
        : `<:${emoji.name}:${emoji.id}>`;
      emojiList.push(`${emoji.name} (${format})`);
    }
    return emojiList.join(", ");
  }

  private resolveEmoji(emojiString: string): string | null {
    const trimmed = emojiString.trim();
    if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
      return trimmed;
    }
    const customEmoji = this.ctx.customEmoji.get(trimmed);
    if (customEmoji) {
      return customEmoji.animated
        ? `<a:${customEmoji.name}:${customEmoji.id}>`
        : `<:${customEmoji.name}:${customEmoji.id}>`;
    }
    return trimmed;
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || message.system || !message.inGuild()) {
      return;
    }
    if (Math.random() > 0.15) {
      return;
    }
    const customEmojiList = this.buildEmojiList();
    const emojiContext =
      customEmojiList.length > 0
        ? `\n\nAvailable custom emoji: ${customEmojiList}\nYou can use either standard Unicode emoji or custom emoji names/format.`
        : "";
    const contextMessages = this.ctx.conversation?.buildContextMessages(
      message.channelId,
    ) || [];
    const result = await this.ctx.openai.chat({
      messages: [
        {
          role: "system",
          content:
            "Respond only with emojis separated by spaces. You can use standard Unicode emoji or custom Discord emoji names/formats.",
        },
        ...contextMessages,
        {
          role: "user",
          content: `You read Discord chat messages and react with up to 3 emojis.\nMessages: "${message.author.displayName || message.author.username}: ${message.content}"\nRespond with emojis separated by spaces only.${emojiContext}`,
        },
      ],
    });
    await result.match(
      async (text) => {
        const emojis = text
          .split(/\s+/)
          .map((token) => this.resolveEmoji(token))
          .filter((emoji): emoji is string => emoji !== null)
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
      },
    );
  }
}
