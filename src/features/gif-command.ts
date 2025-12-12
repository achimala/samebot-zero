import type { ChatInputCommandInteraction } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import {
  EmojiGenerator,
  type ReferenceImage,
  type GifOptions,
  DEFAULT_GIF_OPTIONS,
} from "../utils/emoji-generator";

export class GifCommandFeature implements Feature {
  private ctx!: RuntimeContext;
  private emojiGenerator!: EmojiGenerator;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.emojiGenerator = new EmojiGenerator(context);
    context.discord.on("interactionCreate", (interaction) => {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "gif") {
          void this.handleGif(interaction);
        }
        return;
      }
    });
  }

  private async handleGif(interaction: ChatInputCommandInteraction) {
    const prompt = interaction.options.getString("prompt", true);
    const referenceAttachment = interaction.options.getAttachment("reference");
    const frames = interaction.options.getInteger("frames") ?? DEFAULT_GIF_OPTIONS.frames;
    const fps = interaction.options.getInteger("fps") ?? DEFAULT_GIF_OPTIONS.fps;
    const loopDelay = interaction.options.getInteger("loop_delay") ?? DEFAULT_GIF_OPTIONS.loopDelay;
    const removeBackground = interaction.options.getBoolean("remove_background") ?? true;

    const gifOptions: GifOptions = { frames, fps, loopDelay, removeBackground };

    await interaction.deferReply();

    let referenceImages: ReferenceImage[] | undefined;
    if (
      referenceAttachment &&
      referenceAttachment.contentType?.startsWith("image/")
    ) {
      const imageData = await this.fetchImageAsBase64(referenceAttachment.url);
      if (imageData) {
        referenceImages = [
          { data: imageData, mimeType: referenceAttachment.contentType },
        ];
      }
    }

    const preview = await this.emojiGenerator.generateGifPreview(
      prompt,
      referenceImages,
      undefined,
      gifOptions,
    );

    if (!preview) {
      await interaction.editReply({
        content: "Failed to generate GIF",
      });
      return;
    }

    await interaction.editReply({
      files: [
        {
          attachment: preview.buffer,
          name: "samebot-gif.gif",
          description: prompt,
        },
      ],
    });
  }

  private async fetchImageAsBase64(url: string): Promise<string | null> {
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer).toString("base64");
    } catch (error) {
      this.ctx.logger.warn(
        { err: error, url },
        "Failed to fetch reference image",
      );
      return null;
    }
  }
}
