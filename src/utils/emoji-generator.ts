import { ChannelType, type Guild, type GuildEmoji } from "discord.js";
import type { RuntimeContext } from "../core/runtime";
import { processEmojiImage } from "./image-processing";

const MAX_EMOJI_SLOTS = 50;

interface EmojiNameResponse {
  name: string;
}

export interface GeneratedEmoji {
  emoji: GuildEmoji;
  name: string;
}

export interface ReferenceImage {
  data: string;
  mimeType: string;
}

export class EmojiGenerator {
  constructor(private readonly ctx: RuntimeContext) {}

  async generate(
    prompt: string,
    referenceImages?: ReferenceImage[],
  ): Promise<GeneratedEmoji | null> {
    const emojiGuild = this.ctx.discord.guilds.cache.get(
      this.ctx.config.emojiGuildId,
    );
    if (!emojiGuild) {
      this.ctx.logger.error(
        { emojiGuildId: this.ctx.config.emojiGuildId },
        "Emoji guild not found",
      );
      return null;
    }

    const nameResult = await this.generateEmojiName(prompt);
    if (nameResult.isErr()) {
      this.ctx.logger.error(
        { err: nameResult.error },
        "Failed to generate emoji name",
      );
      return null;
    }
    const emojiName = nameResult.value;

    const imageOptions: Parameters<typeof this.ctx.openai.generateImage>[0] = {
      prompt: `${prompt}, solid bright magenta background (#FF00FF), suitable as a Discord emoji. Will be displayed very small, so make things clear and avoid fine details or small text`,
      aspectRatio: "1:1",
      imageSize: "1K",
    };
    if (referenceImages) {
      imageOptions.referenceImages = referenceImages;
    }
    const imageResult = await this.ctx.openai.generateImage(imageOptions);

    if (imageResult.isErr()) {
      this.ctx.logger.error(
        { err: imageResult.error },
        "Image generation failed",
      );
      return null;
    }

    const { buffer } = imageResult.value;

    try {
      const processedBuffer = await processEmojiImage(buffer);
      await this.ensureCapacity(emojiGuild);

      const createdEmoji = await emojiGuild.emojis.create({
        attachment: processedBuffer,
        name: emojiName,
      });

      this.ctx.logger.info(
        { emojiId: createdEmoji.id, emojiName: createdEmoji.name },
        "Created new emoji",
      );

      await this.announceNewEmoji(
        emojiGuild,
        createdEmoji.toString(),
        emojiName,
        processedBuffer,
      );

      return { emoji: createdEmoji, name: emojiName };
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Failed to create emoji");
      return null;
    }
  }

  private async ensureCapacity(emojiGuild: Guild) {
    const emojis = await emojiGuild.emojis.fetch();
    if (emojis.size >= MAX_EMOJI_SLOTS) {
      const oldestEmoji = emojis.reduce((oldest, current) =>
        oldest.id < current.id ? oldest : current,
      );
      const deletedName = oldestEmoji.name;
      await oldestEmoji.delete();
      this.ctx.logger.info(
        { emojiId: oldestEmoji.id, emojiName: deletedName },
        "Deleted oldest emoji to make room",
      );
      await this.announcePurgedEmoji(emojiGuild, deletedName);
    }
  }

  private getGeneralChannel(emojiGuild: Guild) {
    return emojiGuild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildText && channel.name === "general",
    );
  }

  private async announceNewEmoji(
    emojiGuild: Guild,
    emojiString: string,
    emojiName: string,
    imageBuffer: Buffer,
  ) {
    const generalChannel = this.getGeneralChannel(emojiGuild);

    if (!generalChannel) {
      this.ctx.logger.warn(
        { guildId: emojiGuild.id },
        "No #general channel found for emoji announcement",
      );
      return;
    }

    const result = await this.ctx.messenger.sendBuffer(
      generalChannel.id,
      imageBuffer,
      `${emojiName}.png`,
      `New emoji created: ${emojiString} \`:${emojiName}:\``,
    );

    if (result.isErr()) {
      this.ctx.logger.error(
        { err: result.error, emojiName },
        "Failed to announce new emoji",
      );
    }
  }

  private async announcePurgedEmoji(
    emojiGuild: Guild,
    emojiName: string | null,
  ) {
    const generalChannel = this.getGeneralChannel(emojiGuild);

    if (!generalChannel) {
      return;
    }

    const result = await this.ctx.messenger.sendToChannel(
      generalChannel.id,
      `Purged old emoji \`:${emojiName ?? "unknown"}:\` to make room for a new one`,
    );

    if (result.isErr()) {
      this.ctx.logger.error(
        { err: result.error, emojiName },
        "Failed to announce purged emoji",
      );
    }
  }

  private generateEmojiName(prompt: string) {
    return this.ctx.openai
      .chatStructured<EmojiNameResponse>({
        messages: [
          {
            role: "system",
            content: `Generate a short, descriptive emoji name based on the user's prompt.
The name must:
- Be 2-32 characters long
- Only contain lowercase letters, numbers, and underscores
- Start with a letter
- Be descriptive of the emoji content
- Not include words like "emoji" or "icon"

Return only the name, no explanation.`,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        schema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The emoji name (2-32 chars, lowercase alphanumeric and underscores only, must start with a letter)",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        schemaName: "emojiName",
        schemaDescription: "Generated emoji name based on prompt",
        model: "gpt-5-nano",
      })
      .map((response) => this.sanitizeEmojiName(response.name));
  }

  private sanitizeEmojiName(input: string): string {
    let name = input
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+/g, "_")
      .replace(/_$/, "")
      .slice(0, 32);

    if (name.length < 2) {
      name = "emoji_" + name;
    }

    return name;
  }
}
