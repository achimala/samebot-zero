import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { EmojiGenerator, type ReferenceImage } from "../utils/emoji-generator";

export class GifEmojiFeature implements Feature {
  private ctx!: RuntimeContext;
  private emojiGenerator!: EmojiGenerator;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.emojiGenerator = new EmojiGenerator(context);
    context.discord.on("interactionCreate", (interaction) => {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "gifemoji") {
          void this.handleGifEmoji(interaction);
        }
        return;
      }
      if (interaction.isButton()) {
        if (interaction.customId.startsWith("gifemoji-save-")) {
          void this.handleSaveButton(interaction);
        } else if (interaction.customId.startsWith("gifemoji-reroll-")) {
          void this.handleRerollButton(interaction);
        } else if (interaction.customId.startsWith("gifemoji-cancel-")) {
          void this.handleCancelButton(interaction);
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith("gifemoji-reroll-modal-")) {
          void this.handleRerollModal(interaction);
        }
        return;
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
    );

    if (!preview) {
      await interaction.editReply({
        content: "Failed to generate GIF emoji preview",
      });
      return;
    }

    const previewId = await this.emojiGenerator.postPreviewWithButtons(preview);

    if (!previewId) {
      await interaction.editReply({
        content: "Failed to post GIF emoji preview",
      });
      return;
    }

    await interaction.editReply({
      content: `GIF emoji preview posted! Check #general in the emoji server to save or reroll.`,
    });
  }

  private async handleSaveButton(interaction: ButtonInteraction) {
    const previewId = interaction.customId.replace("gifemoji-save-", "");
    const preview = this.emojiGenerator.getPendingPreview(previewId);

    if (!preview) {
      await interaction.reply({
        content: "This GIF emoji preview has expired or already been processed.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();

    const result = await this.emojiGenerator.saveEmoji(preview);
    this.emojiGenerator.deletePendingPreview(previewId);

    if (!result) {
      await interaction.message.edit({
        content: `**:${preview.name}:** ${preview.prompt}\n❌ Failed to save GIF emoji`,
        components: [],
      });
      return;
    }

    await interaction.message.edit({
      content: `**:${result.name}:** ${preview.prompt}\n✅ Saved animated emoji! ${result.emoji}`,
      components: [],
    });
  }

  private async handleRerollButton(interaction: ButtonInteraction) {
    const previewId = interaction.customId.replace("gifemoji-reroll-", "");
    const preview = this.emojiGenerator.getPendingPreview(previewId);

    if (!preview) {
      await interaction.reply({
        content: "This GIF emoji preview has expired or already been processed.",
        ephemeral: true,
      });
      return;
    }

    const modal = this.emojiGenerator.createRerollModal(
      previewId,
      interaction.message.id,
      preview.name,
      preview.prompt,
      true,
    );

    await interaction.showModal(modal);
  }

  private async handleRerollModal(interaction: ModalSubmitInteraction) {
    const customIdWithoutPrefix = interaction.customId.replace(
      "gifemoji-reroll-modal-",
      "",
    );
    const lastHyphenIndex = customIdWithoutPrefix.lastIndexOf("-");
    if (lastHyphenIndex === -1) {
      await interaction.reply({
        content: "Invalid modal interaction.",
        ephemeral: true,
      });
      return;
    }
    const previewId = customIdWithoutPrefix.substring(0, lastHyphenIndex);
    const messageId = customIdWithoutPrefix.substring(lastHyphenIndex + 1);
    const preview = this.emojiGenerator.getPendingPreview(previewId);

    if (!preview) {
      await interaction.reply({
        content: "This GIF emoji preview has expired or already been processed.",
        ephemeral: true,
      });
      return;
    }

    if (!interaction.channel) {
      await interaction.reply({
        content: "Unable to access the channel.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const modeValues = interaction.fields.getStringSelectValues("emoji-mode");
    const selectedMode = modeValues[0] ?? "fresh";
    const nameInput = interaction.fields.getTextInputValue("emoji-name");
    const promptInput = interaction.fields.getTextInputValue("emoji-prompt");

    const message = await interaction.channel.messages.fetch(messageId);
    if (!message) {
      await interaction.followUp({
        content: "Unable to find the original message.",
        ephemeral: true,
      });
      return;
    }

    const isEditMode = selectedMode === "edit";
    const statusMessage = isEditMode ? "Editing..." : "Rerolling...";

    await message.edit({
      content: `**:${preview.name}:** ${preview.prompt}\n🔄 ${statusMessage}`,
      components: [],
    });

    this.emojiGenerator.deletePendingPreview(previewId);

    let referenceImages = preview.referenceImages ?? [];
    if (isEditMode) {
      const previousImageAsReference: ReferenceImage = {
        data: preview.buffer.toString("base64"),
        mimeType: "image/gif",
      };
      referenceImages = [previousImageAsReference, ...referenceImages];
    }

    const newPreview = await this.emojiGenerator.generateGifPreview(
      promptInput,
      referenceImages.length > 0 ? referenceImages : undefined,
      nameInput,
    );

    if (!newPreview) {
      await message.edit({
        content: `**:${preview.name}:** ${preview.prompt}\n❌ Failed to generate new GIF preview`,
        components: [],
      });
      return;
    }

    const newPreviewId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.emojiGenerator.setPendingPreview(newPreviewId, newPreview);

    await this.emojiGenerator.updatePreviewMessage(
      message,
      newPreview,
      newPreviewId,
    );

    await interaction.deleteReply();
  }

  private async handleCancelButton(interaction: ButtonInteraction) {
    const previewId = interaction.customId.replace("gifemoji-cancel-", "");
    const preview = this.emojiGenerator.getPendingPreview(previewId);

    if (!preview) {
      await interaction.reply({
        content: "This GIF emoji preview has expired or already been processed.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();

    this.emojiGenerator.deletePendingPreview(previewId);

    await interaction.message.delete();
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
