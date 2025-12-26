import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { EntityResolver } from "../utils/entity-resolver";

interface ImageGenerationData {
  prompt: string;
  effectivePrompt: string;
  referenceImages: Array<{ data: string; mimeType: string }> | undefined;
  buffer: Buffer;
  promptChain: string[];
}

export class ImageCommandFeature implements Feature {
  private ctx!: RuntimeContext;
  private entityResolver!: EntityResolver;
  private imageDataMap = new Map<string, ImageGenerationData>();

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.entityResolver = new EntityResolver(context.supabase, context.logger);
    context.discord.on("interactionCreate", (interaction) => {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "img") {
          void this.handleImage(interaction);
        }
        return;
      }
      if (interaction.isButton()) {
        if (interaction.customId.startsWith("img-edit-")) {
          void this.handleEditButton(interaction);
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith("img-edit-modal-")) {
          void this.handleEditModal(interaction);
        }
        return;
      }
    });
  }

  private async handleImage(interaction: ChatInputCommandInteraction) {
    const prompt = interaction.options.getString("prompt", true);
    await interaction.deferReply();

    let effectivePrompt = prompt;
    let referenceImages: Array<{ data: string; mimeType: string }> | undefined;

    const resolution = await this.entityResolver.resolve(prompt);
    if (resolution) {
      const built = this.entityResolver.buildPromptWithReferences(resolution);
      effectivePrompt = built.textPrompt;
      referenceImages = built.referenceImages;
    }

    const imageOptions: Parameters<typeof this.ctx.openai.generateImage>[0] = {
      prompt: effectivePrompt,
    };
    if (referenceImages) {
      imageOptions.referenceImages = referenceImages;
    }
    const result = await this.ctx.openai.generateImage(imageOptions);
    await result.match(
      async ({ buffer }) => {
        const promptChain = [prompt];
        const message = await interaction.editReply({
          files: [
            {
              attachment: buffer,
              name: "samebot-image.png",
              description: promptChain.join(" → "),
            },
          ],
        });

        const messageId = message.id;
        await message.edit({
          components: [this.createEditButtonRow(messageId)],
        });

        this.imageDataMap.set(messageId, {
          prompt,
          effectivePrompt,
          referenceImages,
          buffer,
          promptChain,
        });
      },
      async (error) => {
        this.ctx.logger.error({ err: error }, "Image generation failed");
        await interaction.editReply("couldn't draw that, sorry");
      },
    );
  }

  private createEditButtonRow(messageId: string): ActionRowBuilder<ButtonBuilder> {
    const editButton = new ButtonBuilder()
      .setCustomId(`img-edit-${messageId}`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Primary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(editButton);
  }

  private async handleEditButton(interaction: ButtonInteraction) {
    const messageId = interaction.customId.replace("img-edit-", "");
    const imageData = this.imageDataMap.get(messageId);

    if (!imageData) {
      await interaction.reply({
        content: "This image has expired or cannot be edited.",
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`img-edit-modal-${messageId}`)
      .setTitle("Edit Image");

    const promptInput = new TextInputBuilder()
      .setCustomId("edit-prompt")
      .setLabel("Edit Prompt")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Describe how to modify the image...")
      .setRequired(true)
      .setMaxLength(1000)
      .setValue(imageData.prompt);

    const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
      promptInput,
    );

    modal.addComponents(actionRow);

    await interaction.showModal(modal);
  }

  private async handleEditModal(interaction: ModalSubmitInteraction) {
    const messageId = interaction.customId.replace("img-edit-modal-", "");
    const imageData = this.imageDataMap.get(messageId);

    if (!imageData) {
      await interaction.reply({
        content: "This image has expired or cannot be edited.",
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

    const newPrompt = interaction.fields.getTextInputValue("edit-prompt");

    const message = await interaction.channel.messages.fetch(messageId);
    if (!message) {
      await interaction.followUp({
        content: "Unable to find the original message.",
        ephemeral: true,
      });
      return;
    }

    await message.edit({
      content: "Editing...",
      components: [],
    });

    let effectivePrompt = newPrompt;
    let referenceImages = imageData.referenceImages;

    const previousImageAsReference = {
      data: imageData.buffer.toString("base64"),
      mimeType: "image/png",
    };

    const resolution = await this.entityResolver.resolve(newPrompt);
    if (resolution) {
      const built = this.entityResolver.buildPromptWithReferences(resolution);
      effectivePrompt = built.textPrompt;
      referenceImages = built.referenceImages
        ? [previousImageAsReference, ...built.referenceImages]
        : [previousImageAsReference];
    } else {
      referenceImages = imageData.referenceImages
        ? [previousImageAsReference, ...imageData.referenceImages]
        : [previousImageAsReference];
    }

    const imageOptions: Parameters<typeof this.ctx.openai.generateImage>[0] = {
      prompt: effectivePrompt,
      referenceImages,
    };

    const result = await this.ctx.openai.generateImage(imageOptions);
    await result.match(
      async ({ buffer }) => {
        const promptChain = [...imageData.promptChain, newPrompt];
        await message.edit({
          content: "",
          files: [
            {
              attachment: buffer,
              name: "samebot-image.png",
              description: promptChain.join(" → "),
            },
          ],
          components: [this.createEditButtonRow(messageId)],
        });

        this.imageDataMap.set(messageId, {
          prompt: newPrompt,
          effectivePrompt,
          referenceImages,
          buffer,
          promptChain,
        });

        await interaction.deleteReply();
      },
      async (error) => {
        this.ctx.logger.error({ err: error }, "Image editing failed");
        await message.edit({
          content: "Failed to edit image. Please try again.",
          components: [this.createEditButtonRow(messageId)],
        });
        await interaction.followUp({
          content: "Failed to edit image. Please try again.",
          ephemeral: true,
        });
      },
    );
  }
}
