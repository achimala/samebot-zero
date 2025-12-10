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
import { processEmojiImage, processGifEmojiGrid } from "./image-processing";
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
  isGif?: boolean;
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
    customName?: string,
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

    // Run name generation and image generation in parallel
    const namePromise: Promise<string | null> = customName
      ? Promise.resolve(this.sanitizeEmojiName(customName))
      : (async () => {
          const result = await this.generateEmojiName(prompt);
          if (result.isErr()) {
            this.ctx.logger.error(
              { err: result.error },
              "Failed to generate emoji name",
            );
            return null;
          }
          return result.value;
        })();

    const imageOptions: Parameters<typeof this.ctx.openai.generateImage>[0] = {
      prompt: `${effectivePrompt}, solid bright magenta background (#FF00FF), suitable as a Discord emoji. Will be displayed very small, so make things clear and avoid fine details or small text`,
      aspectRatio: "1:1",
      imageSize: "1K",
    };
    if (effectiveReferenceImages && effectiveReferenceImages.length > 0) {
      imageOptions.referenceImages = effectiveReferenceImages;
    }
    const imagePromise = this.ctx.openai.generateImage(imageOptions);

    const [emojiName, imageResult] = await Promise.all([
      namePromise,
      imagePromise,
    ]);

    if (!emojiName) {
      return null;
    }

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

  async generateGifPreview(
    prompt: string,
    referenceImages?: ReferenceImage[],
    customName?: string,
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

    const namePromise: Promise<string | null> = customName
      ? Promise.resolve(this.sanitizeEmojiName(customName))
      : (async () => {
          const result = await this.generateEmojiName(prompt);
          if (result.isErr()) {
            this.ctx.logger.error(
              { err: result.error },
              "Failed to generate emoji name",
            );
            return null;
          }
          return result.value;
        })();

    const gifPrompt = this.buildGifPrompt(effectivePrompt);
    const imageOptions: Parameters<typeof this.ctx.openai.generateImage>[0] = {
      prompt: gifPrompt,
      aspectRatio: "1:1",
      imageSize: "1K",
    };
    if (effectiveReferenceImages && effectiveReferenceImages.length > 0) {
      imageOptions.referenceImages = effectiveReferenceImages;
    }
    const imagePromise = this.ctx.openai.generateImage(imageOptions);

    const [emojiName, imageResult] = await Promise.all([
      namePromise,
      imagePromise,
    ]);

    if (!emojiName) {
      return null;
    }

    if (imageResult.isErr()) {
      this.ctx.logger.error(
        { err: imageResult.error },
        "GIF image generation failed",
      );
      return null;
    }

    const { buffer } = imageResult.value;

    try {
      const gifBuffer = await processGifEmojiGrid(buffer);
      return {
        name: emojiName,
        buffer: gifBuffer,
        prompt,
        referenceImages: effectiveReferenceImages,
        isGif: true,
      };
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Failed to process GIF emoji");
      return null;
    }
  }

  private buildGifPrompt(prompt: string): string {
    return [
      prompt,
      "solid bright magenta background (#FF00FF) wherever it should be transparent",
      "suitable as a Discord emoji",
      "will be displayed very small so make things clear and avoid fine details or small text",
      "",
      "Create a 3x3 grid of animation frames showing the progression of this emoji.",
      "Each frame should be as stable as possible with minimal changes between frames.",
      "Arranged in a 3x3 grid layout (3 rows, 3 columns).",
      "The frames should show a smooth animation sequence from top-left to bottom-right.",
      "",
      "IMPORTANT: Do NOT draw any borders, lines, gaps, or separators between frames.",
      "The frames must tile directly against each other with no visible divisions.",
    ].join(" ");
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

    const buttonPrefix = preview.isGif ? "gifemoji" : "emoji";
    const fileExtension = preview.isGif ? "gif" : "png";

    const saveButton = new ButtonBuilder()
      .setCustomId(`${buttonPrefix}-save-${previewId}`)
      .setLabel("Save")
      .setStyle(ButtonStyle.Success);

    const rerollButton = new ButtonBuilder()
      .setCustomId(`${buttonPrefix}-reroll-${previewId}`)
      .setLabel("Reroll")
      .setStyle(ButtonStyle.Secondary);

    const cancelButton = new ButtonBuilder()
      .setCustomId(`${buttonPrefix}-cancel-${previewId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      saveButton,
      rerollButton,
      cancelButton,
    );

    try {
      const channel = generalChannel as TextChannel;
      await channel.send({
        content: `**:${preview.name}:** ${preview.prompt}`,
        files: [
          {
            attachment: preview.buffer,
            name: `${preview.name}.${fileExtension}`,
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

  createRerollModal(
    previewId: string,
    messageId: string,
    currentName: string,
    currentPrompt: string,
    isGif: boolean = false,
  ) {
    const prefix = isGif ? "gifemoji" : "emoji";
    return {
      custom_id: `${prefix}-reroll-modal-${previewId}-${messageId}`,
      title: "Reroll Emoji",
      components: [
        {
          type: 18,
          label: "Generation Mode",
          component: {
            type: 3,
            custom_id: "emoji-mode",
            placeholder: "Choose how to generate...",
            options: [
              {
                label: "Start Fresh",
                value: "fresh",
                description: "Generate a completely new image",
                default: true,
              },
              {
                label: "Edit Previous",
                value: "edit",
                description: "Modify the current image",
              },
            ],
          },
        },
        {
          type: 18,
          label: "Emoji Name",
          component: {
            type: 4,
            custom_id: "emoji-name",
            style: 1,
            placeholder:
              "Enter emoji name (2-32 chars, lowercase alphanumeric and underscores)",
            required: true,
            max_length: 32,
            value: currentName,
          },
        },
        {
          type: 18,
          label: "Prompt",
          description:
            "Enter image generation prompt (or edit instructions if editing)",
          component: {
            type: 4,
            custom_id: "emoji-prompt",
            style: 2,
            placeholder: "Describe the emoji you want to create...",
            required: true,
            max_length: 500,
            value: currentPrompt,
          },
        },
      ],
    };
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
    const buttonPrefix = preview.isGif ? "gifemoji" : "emoji";
    const fileExtension = preview.isGif ? "gif" : "png";

    const saveButton = new ButtonBuilder()
      .setCustomId(`${buttonPrefix}-save-${newPreviewId}`)
      .setLabel("Save")
      .setStyle(ButtonStyle.Success);

    const editButton = new ButtonBuilder()
      .setCustomId(`${buttonPrefix}-edit-${newPreviewId}`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Primary);

    const rerollButton = new ButtonBuilder()
      .setCustomId(`${buttonPrefix}-reroll-${newPreviewId}`)
      .setLabel("Reroll")
      .setStyle(ButtonStyle.Secondary);

    const cancelButton = new ButtonBuilder()
      .setCustomId(`${buttonPrefix}-cancel-${newPreviewId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      saveButton,
      editButton,
      rerollButton,
      cancelButton,
    );

    await message.edit({
      content: `**:${preview.name}:** ${preview.prompt}`,
      files: [
        {
          attachment: preview.buffer,
          name: `${preview.name}.${fileExtension}`,
        },
      ],
      components: [row],
    });
  }

  async ensureCapacity(emojiGuild: Guild) {
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

  generateEmojiName(prompt: string) {
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
- Exclude filler words and be as compact as possible, just preserving the most important words, usually only 3 words or less

Examples:
- "a cat on a chair" -> "cat_on_chair"
- "mchang as a pepe" -> "mchang_pepe"
- "cool sunglasses emoji but with tyrus's face" -> "cool_tyrus"

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
