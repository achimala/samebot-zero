import type { Message } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

export class AutoReactFeature implements Feature {
  private ctx!: RuntimeContext;
  private botUserId?: string;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.once("ready", (client) => {
      this.botUserId = client.user.id;
    });
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

  private isExplicitReactRequest(message: Message): boolean {
    if (this.botUserId && message.mentions.users.has(this.botUserId)) {
      return true;
    }
    const content = message.content || "";
    const lowerContent = content.toLowerCase();
    const reactPatterns = [
      /react\s+to\s+(this|that|it|my\s+message)/i,
      /please\s+react/i,
      /can\s+you\s+react/i,
      /would\s+you\s+react/i,
      /react\s+please/i,
      /samebot.*react/i,
      /react.*samebot/i,
    ];
    return reactPatterns.some((pattern) => pattern.test(lowerContent));
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || message.system || !message.inGuild()) {
      return;
    }

    const isExplicitRequest = this.isExplicitReactRequest(message);

    if (!isExplicitRequest && Math.random() > 0.15) {
      return;
    }

    const customEmojiList = this.buildEmojiList();
    const emojiContext =
      customEmojiList.length > 0
        ? `\n\nAvailable custom emoji: ${customEmojiList}\nYou can use either standard Unicode emoji or custom emoji names/format.`
        : "";
    const prompt = `You read Discord chat messages and react with up to 3 emojis.
Messages: "${message.author.displayName || message.author.username}: ${message.content}"
Respond with emojis separated by spaces only.${emojiContext}`;
    const result = await this.ctx.openai.chat({
      messages: [
        {
          role: "system",
          content:
            "Respond only with emojis separated by spaces. You can use standard Unicode emoji or custom Discord emoji names/formats.",
        },
        { role: "user", content: prompt },
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
