import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Guild,
  type GuildEmoji,
  type TextChannel,
  type Message,
} from "discord.js";
import type { RuntimeContext } from "../core/runtime";
import { processEmojiImage } from "./image-processing";
import { EntityResolver } from "./entity-resolver";

const MAX_EMOJI_SLOTS = 50;

interface EmojiNameResponse {
  name: string;
}

export interface GeneratedEmoji {
  emoji: GuildEmoji;
  name: string;
}

export interface EmojiPreview {
  name: string;
  buffer: Buffer;
  prompt: string;
  referenceImages: ReferenceImage[] | undefined;
}

export interface ReferenceImage {
  data: string;
  mimeType: string;
}

export class EmojiGenerator {
  private readonly entityResolver: EntityResolver;
  private pendingPreviews = new Map<string, EmojiPreview>();

  constructor(private readonly ctx: RuntimeContext) {
    this.entityResolver = new EntityResolver(ctx.supabase, ctx.logger);
  }

  async generatePreview(
    prompt: string,
    referenceImages?: ReferenceImage[],
  ): Promise<EmojiPreview | null> {
    let effectivePrompt = prompt;
    let effectiveReferenceImages = referenceImages;

    if (!referenceImages || referenceImages.length === 0) {
      const resolution = await this.entityResolver.resolve(prompt);
      if (resolution) {
        const built = this.entityResolver.buildPromptWithReferences(resolution);
        effectivePrompt = built.textPrompt;
        effectiveReferenceImages = built.referenceImages;
      }
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
      prompt: `${effectivePrompt}, solid bright magenta background (#FF00FF), suitable as a Discord emoji. Will be displayed very small, so make things clear and avoid fine details or small text`,
      aspectRatio: "1:1",
      imageSize: "1K",
    };
    if (effectiveReferenceImages && effectiveReferenceImages.length > 0) {
      imageOptions.referenceImages = effectiveReferenceImages;
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
      return {
        name: emojiName,
        buffer: processedBuffer,
        prompt,
        referenceImages: effectiveReferenceImages,
      };
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Failed to process emoji image");
      return null;
    }
  }

  async postPreviewWithButtons(preview: EmojiPreview): Promise<string | null> {
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

    const generalChannel = this.getGeneralChannel(emojiGuild);
    if (!generalChannel) {
      this.ctx.logger.warn(
        { guildId: emojiGuild.id },
        "No #general channel found for emoji preview",
      );
      return null;
    }

    const previewId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    this.pendingPreviews.set(previewId, preview);

    const saveButton = new ButtonBuilder()
      .setCustomId(`emoji-save-${previewId}`)
      .setLabel("Save")
      .setStyle(ButtonStyle.Success);

    const rerollButton = new ButtonBuilder()
      .setCustomId(`emoji-reroll-${previewId}`)
      .setLabel("Reroll")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      saveButton,
      rerollButton,
    );

    try {
      const channel = generalChannel as TextChannel;
      await channel.send({
        content: `**:${preview.name}:** ${preview.prompt}`,
        files: [
          {
            attachment: preview.buffer,
            name: `${preview.name}.png`,
          },
        ],
        components: [row],
      });

      return previewId;
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Failed to post emoji preview");
      this.pendingPreviews.delete(previewId);
      return null;
    }
  }

  getPendingPreview(previewId: string): EmojiPreview | undefined {
    return this.pendingPreviews.get(previewId);
  }

  setPendingPreview(previewId: string, preview: EmojiPreview): void {
    this.pendingPreviews.set(previewId, preview);
  }

  deletePendingPreview(previewId: string): void {
    this.pendingPreviews.delete(previewId);
  }

  async saveEmoji(preview: EmojiPreview): Promise<GeneratedEmoji | null> {
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

    try {
      await this.ensureCapacity(emojiGuild);

      const createdEmoji = await emojiGuild.emojis.create({
        attachment: preview.buffer,
        name: preview.name,
      });

      this.ctx.logger.info(
        { emojiId: createdEmoji.id, emojiName: createdEmoji.name },
        "Created new emoji",
      );

      return { emoji: createdEmoji, name: preview.name };
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Failed to create emoji");
      return null;
    }
  }

  async updatePreviewMessage(
    message: Message,
    preview: EmojiPreview,
    newPreviewId: string,
  ): Promise<void> {
    const saveButton = new ButtonBuilder()
      .setCustomId(`emoji-save-${newPreviewId}`)
      .setLabel("Save")
      .setStyle(ButtonStyle.Success);

    const rerollButton = new ButtonBuilder()
      .setCustomId(`emoji-reroll-${newPreviewId}`)
      .setLabel("Reroll")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      saveButton,
      rerollButton,
    );

    await message.edit({
      content: `**:${preview.name}:** ${preview.prompt}`,
      files: [
        {
          attachment: preview.buffer,
          name: `${preview.name}.png`,
        },
      ],
      components: [row],
    });
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
