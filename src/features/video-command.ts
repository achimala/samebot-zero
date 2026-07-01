import type { ChatInputCommandInteraction } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import {
  EmojiGenerator,
  type ReferenceImage,
} from "../utils/emoji-generator";

export class VideoCommandFeature implements Feature {
  private ctx!: RuntimeContext;
  private emojiGenerator!: EmojiGenerator;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.emojiGenerator = new EmojiGenerator(context);
    context.discord.on("interactionCreate", (interaction) => {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "video") {
          void this.handleVideo(interaction).catch((error) => {
            this.ctx.logger.error({ err: error }, "Video command failed");
          });
        }
        return;
      }
    });
  }

  private async handleVideo(interaction: ChatInputCommandInteraction) {
    const prompt = interaction.options.getString("prompt", true);
    const referenceAttachment = interaction.options.getAttachment("reference");
    const aspectRatioChoice = interaction.options.getString("aspect_ratio");
    const aspectRatio = aspectRatioChoice === "9:16" ? "9:16" : "16:9";

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

    const videoBuffer = await this.emojiGenerator.generateVideo(
      prompt,
      referenceImages,
      aspectRatio,
    );

    if (!videoBuffer) {
      await interaction.editReply({
        content: "Failed to generate video",
      });
      return;
    }

    await interaction.editReply({
      files: [
        {
          attachment: videoBuffer,
          name: "samebot-video.mp4",
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
