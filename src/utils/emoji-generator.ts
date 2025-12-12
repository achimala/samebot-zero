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
import {
  processEmojiImage,
  processGifEmojiGrid,
  buildGifPrompt,
  type GifOptions,
} from "./image-processing";
import { EntityResolver } from "./entity-resolver";

const MAX_EMOJI_SLOTS = 50;

interface EmojiNameResponse {
  name: string;
}

export interface GeneratedEmoji {
  emoji: GuildEmoji;
  name: string;
}

export type { GifOptions };

export const DEFAULT_GIF_OPTIONS: GifOptions = {
  frames: 9,
  fps: 5,
  loopDelay: 0,
  removeBackground: true,
};

export interface EmojiPreview {
  name: string;
  buffer: Buffer;
  prompt: string;
  referenceImages: ReferenceImage[] | undefined;
  isGif?: boolean;
  gifOptions?: GifOptions;
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
    gifOptions: GifOptions = DEFAULT_GIF_OPTIONS,
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

    const gridSize = Math.sqrt(gifOptions.frames);
    const removeBackground = gifOptions.removeBackground !== false;
    const gifPrompt = buildGifPrompt(effectivePrompt, gridSize, true, removeBackground);
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
      const gifBuffer = await processGifEmojiGrid(buffer, gifOptions);
      return {
        name: emojiName,
        buffer: gifBuffer,
        prompt,
        referenceImages: effectiveReferenceImages,
        isGif: true,
        gifOptions,
      };
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Failed to process GIF emoji");
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
    gifOptions?: GifOptions,
  ) {
    const prefix = isGif ? "gifemoji" : "emoji";

    const baseComponents = [
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
    ];

    if (isGif && gifOptions) {
      baseComponents.push({
        type: 18,
        label: "GIF Settings (frames,fps,loop_delay)",
        component: {
          type: 4,
          custom_id: "gif-settings",
          style: 1,
          placeholder: "e.g. 9,5,0 (frames must be 4,9,16,25)",
          required: true,
          max_length: 20,
          value: `${gifOptions.frames},${gifOptions.fps},${gifOptions.loopDelay}`,
        },
      });
      baseComponents.push({
        type: 18,
        label: "Remove Background",
        component: {
          type: 4,
          custom_id: "gif-remove-background",
          style: 1,
          placeholder: "true or false (default: true)",
          required: false,
          max_length: 5,
          value: String(gifOptions.removeBackground !== false),
        },
      });
    }

    return {
      custom_id: `${prefix}-reroll-modal-${previewId}-${messageId}`,
      title: isGif ? "Reroll GIF Emoji" : "Reroll Emoji",
      components: baseComponents,
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
      await this.ensureCapacity(emojiGuild, preview.isGif ?? false);

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

  async ensureCapacity(emojiGuild: Guild, isGif: boolean) {
    const emojis = await emojiGuild.emojis.fetch();
    const emojisOfType = emojis.filter((emoji) => emoji.animated === isGif);
    
    if (emojisOfType.size >= MAX_EMOJI_SLOTS) {
      const oldestEmoji = emojisOfType.reduce((oldest, current) =>
        oldest.id < current.id ? oldest : current,
      );
      const deletedName = oldestEmoji.name;
      await oldestEmoji.delete();
      this.ctx.logger.info(
        { emojiId: oldestEmoji.id, emojiName: deletedName, isGif },
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
