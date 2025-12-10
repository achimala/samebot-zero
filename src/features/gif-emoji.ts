import type { ChatInputCommandInteraction } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { EmojiGenerator, type ReferenceImage } from "../utils/emoji-generator";
import { processGifEmojiGrid } from "../utils/image-processing";
import { EntityResolver } from "../utils/entity-resolver";

export class GifEmojiFeature implements Feature {
  private ctx!: RuntimeContext;
  private emojiGenerator!: EmojiGenerator;
  private entityResolver!: EntityResolver;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.emojiGenerator = new EmojiGenerator(context);
    this.entityResolver = new EntityResolver(context.supabase, context.logger);
    context.discord.on("interactionCreate", (interaction) => {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "gifemoji") {
          void this.handleGifEmoji(interaction);
        }
      }
    });
  }

  private async handleGifEmoji(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const prompt = interaction.options.getString("prompt", true);
    const referenceAttachment = interaction.options.getAttachment("reference");

    let effectivePrompt = prompt;
    let effectiveReferenceImages: ReferenceImage[] | undefined;

    if (
      referenceAttachment &&
      referenceAttachment.contentType?.startsWith("image/")
    ) {
      const imageData = await this.fetchImageAsBase64(referenceAttachment.url);
      if (imageData) {
        effectiveReferenceImages = [
          { data: imageData, mimeType: referenceAttachment.contentType },
        ];
      }
    }

    if (!effectiveReferenceImages || effectiveReferenceImages.length === 0) {
      const resolution = await this.entityResolver.resolve(prompt);
      if (resolution) {
        const built = this.entityResolver.buildPromptWithReferences(resolution);
        effectivePrompt = built.textPrompt;
        effectiveReferenceImages = built.referenceImages;
      }
    }

    const emojiGuild = this.ctx.discord.guilds.cache.get(
      this.ctx.config.emojiGuildId,
    );
    if (!emojiGuild) {
      await interaction.editReply({
        content: "Emoji guild not found",
      });
      return;
    }

    const finalPrompt = this.buildGifPrompt(effectivePrompt);
    const imageResult = await this.ctx.openai.generateImage({
      prompt: finalPrompt,
      aspectRatio: "1:1",
      imageSize: "1K",
      referenceImages: effectiveReferenceImages,
    });

    if (imageResult.isErr()) {
      this.ctx.logger.error(
        { err: imageResult.error },
        "GIF emoji image generation failed",
      );
      await interaction.editReply({
        content: "Failed to generate GIF emoji",
      });
      return;
    }

    const { buffer } = imageResult.value;

    try {
      const gifBuffer = await processGifEmojiGrid(buffer);

      const emojiNameResult = await this.emojiGenerator.generateEmojiName(
        prompt,
      );
      if (emojiNameResult.isErr()) {
        this.ctx.logger.error(
          { err: emojiNameResult.error },
          "Failed to generate emoji name",
        );
        await interaction.editReply({
          content: "Failed to generate emoji name",
        });
        return;
      }

      const emojiName = emojiNameResult.value;

      await this.emojiGenerator.ensureCapacity(emojiGuild);

      const createdEmoji = await emojiGuild.emojis.create({
        attachment: gifBuffer,
        name: emojiName,
      });

      this.ctx.logger.info(
        { emojiId: createdEmoji.id, emojiName: createdEmoji.name },
        "Created new GIF emoji",
      );

      await interaction.editReply({
        content: `**:${emojiName}:** ${prompt}\n✅ Created animated emoji! ${createdEmoji}`,
      });
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Failed to process GIF emoji");
      await interaction.editReply({
        content: "Failed to process GIF emoji",
      });
    }
  }

  private buildGifPrompt(prompt: string): string {
    const basePrompt = `${prompt}, solid bright magenta background (#FF00FF), suitable as a Discord emoji. Will be displayed very small, so make things clear and avoid fine details or small text`;

    return `${basePrompt}. Create a 3x3 grid of animation frames showing the progression of this emoji. Each frame should be as stable as possible with minimal changes between frames, arranged in a 3x3 grid layout (3 rows, 3 columns). The frames should show a smooth animation sequence from top-left to bottom-right.`;
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
