import type {
  Message,
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
import type { ScrapbookMemory } from "../scrapbook/store";
import { EntityResolver } from "../utils/entity-resolver";

const INACTIVITY_TIMEOUT_MS = 90 * 60 * 1000;
const SCRAPBOOK_EXTRACTION_INTERVAL = 6;

interface ChannelState {
  lastActivityAt: number;
  messagesSinceLastExtraction: number;
  hasSentConversationStarter: boolean;
}

interface ScrapbookImageData {
  prompt: string;
  effectivePrompt: string;
  referenceImages: Array<{ data: string; mimeType: string }> | undefined;
  buffer: Buffer;
}

export class ScrapbookFeature implements Feature {
  private ctx!: RuntimeContext;
  private entityResolver!: EntityResolver;
  private channelStates = new Map<string, ChannelState>();
  private inactivityTimer: NodeJS.Timeout | null = null;
  private imageDataMap = new Map<string, ScrapbookImageData>();

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.entityResolver = new EntityResolver(context.supabase, context.logger);

    context.discord.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });

    context.discord.on("interactionCreate", (interaction) => {
      if (interaction.isButton()) {
        if (interaction.customId.startsWith("scrapbook-edit-")) {
          void this.handleEditButton(interaction);
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith("scrapbook-edit-modal-")) {
          void this.handleEditModal(interaction);
        }
        return;
      }
    });

    context.discord.once("ready", () => {
      this.startInactivityTimer();
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || message.system) {
      return;
    }

    const channelId = message.channelId;
    const isMainChannel = channelId === this.ctx.config.mainChannelId;

    if (!isMainChannel) {
      return;
    }

    let state = this.channelStates.get(channelId);
    if (!state) {
      state = {
        lastActivityAt: Date.now(),
        messagesSinceLastExtraction: 0,
        hasSentConversationStarter: false,
      };
      this.channelStates.set(channelId, state);
    }

    state.lastActivityAt = Date.now();
    state.hasSentConversationStarter = false;
    state.messagesSinceLastExtraction++;

    if (state.messagesSinceLastExtraction >= SCRAPBOOK_EXTRACTION_INTERVAL) {
      await this.runScrapbookDetection(channelId);
      state.messagesSinceLastExtraction = 0;
    }
  }

  private async runScrapbookDetection(channelId: string): Promise<void> {
    const conversationContext = this.ctx.conversation?.getContext(channelId);
    if (!conversationContext || conversationContext.history.length < 3) {
      return;
    }

    const messages: Array<{
      id: string;
      author: string;
      content: string;
      timestamp: number;
    }> = [];

    for (const m of conversationContext.history) {
      if (m.role !== "user") {
        continue;
      }
      const authorMatch = m.content.match(/^([^:]+): (.+)$/);
      const author = authorMatch?.[1] ?? "unknown";
      const content = authorMatch?.[2] ?? m.content;
      messages.push({
        id: m.id,
        author,
        content,
        timestamp: m.timestamp,
      });
    }

    const keyMessageId = await this.ctx.scrapbook.detectKeyMessage(messages);
    if (!keyMessageId) {
      return;
    }

    const keyMessage = messages.find((m) => m.id === keyMessageId);
    if (!keyMessage) {
      this.ctx.logger.warn(
        { keyMessageId },
        "Key message ID not found in messages",
      );
      return;
    }

    await this.ctx.scrapbook.saveMemory(keyMessage, messages);
  }

  private startInactivityTimer(): void {
    this.inactivityTimer = setInterval(() => {
      void this.checkInactivity();
    }, 60000);
  }

  private async checkInactivity(): Promise<void> {
    const mainChannelId = this.ctx.config.mainChannelId;
    const state = this.channelStates.get(mainChannelId);

    if (!state) {
      return;
    }

    if (state.hasSentConversationStarter) {
      return;
    }

    const timeSinceActivity = Date.now() - state.lastActivityAt;
    if (timeSinceActivity < INACTIVITY_TIMEOUT_MS) {
      return;
    }

    await this.sendConversationStarter(mainChannelId, state);
  }

  private async sendConversationStarter(
    channelId: string,
    state: ChannelState,
  ): Promise<void> {
    const memory = await this.ctx.scrapbook.getRandomMemory();
    if (!memory) {
      return;
    }

    state.hasSentConversationStarter = true;

    const formattedMemory = this.formatScrapbookMemory(memory);

    const imagePromptResult = await this.generateImagePromptForMemory(memory);
    if (imagePromptResult) {
      const imageOptions: Parameters<typeof this.ctx.openai.generateImage>[0] = {
        prompt: imagePromptResult.textPrompt,
        aspectRatio: "16:9",
      };
      if (imagePromptResult.referenceImages) {
        imageOptions.referenceImages = imagePromptResult.referenceImages;
      }
      const imageResult = await this.ctx.openai.generateImage(imageOptions);

      await imageResult.match(
        async ({ buffer }) => {
          await this.ctx.messenger.sendToChannel(channelId, formattedMemory);
          const sendResult = await this.ctx.messenger.sendBuffer(
            channelId,
            buffer,
            "scrapbook-memory.png",
            imagePromptResult.textPrompt,
          );
          await sendResult.match(
            async ({ messageId }) => {
              const channel = await this.ctx.discord.channels.fetch(channelId);
              if (channel && channel.isTextBased()) {
                const message = await channel.messages.fetch(messageId);
                await message.edit({
                  components: [this.createEditButtonRow(messageId)],
                });
                this.imageDataMap.set(messageId, {
                  prompt: imagePromptResult.textPrompt,
                  effectivePrompt: imagePromptResult.textPrompt,
                  referenceImages: imagePromptResult.referenceImages,
                  buffer,
                });
              }
            },
            async () => {
              this.ctx.logger.warn(
                "Failed to add edit button to scrapbook image",
              );
            },
          );
        },
        async (error) => {
          this.ctx.logger.warn(
            { err: error },
            "Failed to generate scrapbook image, sending text only",
          );
          await this.ctx.messenger.sendToChannel(channelId, formattedMemory);
        },
      );
    } else {
      await this.ctx.messenger.sendToChannel(channelId, formattedMemory);
    }
  }

  private formatScrapbookMemory(memory: ScrapbookMemory): string {
    return `> ${memory.keyMessage}\n— ${memory.author}`;
  }

  private async generateImagePromptForMemory(
    memory: ScrapbookMemory,
  ): Promise<{ textPrompt: string; referenceImages?: Array<{ data: string; mimeType: string }> } | null> {
    const contextText = memory.context
      .map((m) => `<${m.author}> ${m.content}`)
      .join("\n");

    const authors = new Set<string>();
    authors.add(memory.author);
    for (const m of memory.context) {
      authors.add(m.author);
    }
    const authorText = Array.from(authors).join(" ");

    const entityResolution = await this.entityResolver.resolve(authorText);
    let basePrompt = `Create an image prompt for this memory. Use the full conversation context to capture the scene:\n\nConversation context:\n${contextText}\n\nKey quote: "${memory.keyMessage}" - ${memory.author}`;
    let referenceImages: Array<{ data: string; mimeType: string }> | undefined;

    if (entityResolution) {
      const built = this.entityResolver.buildPromptWithReferences(entityResolution);
      basePrompt = `${built.textPrompt}\n\n${basePrompt}`;
      referenceImages = built.referenceImages;
    }

    const result = await this.ctx.openai.chatStructured<{ prompt: string }>({
      messages: [
        {
          role: "system",
          content: `You create artistic image prompts for nostalgic chat memories.
Given a memorable chat quote and its full conversation context, create a creative, whimsical image prompt that captures the scene and essence of the moment.
The image should be surreal, artistic, and evocative - not a literal depiction.
Use the entire conversation context to understand the scene, mood, and setting of the moment.
Keep the prompt concise (under 100 words).`,
        },
        {
          role: "user",
          content: basePrompt,
        },
      ],
      schema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The image generation prompt",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      schemaName: "imagePrompt",
      model: "gpt-5-mini",
    });

    if (result.isOk()) {
      return {
        textPrompt: result.value.prompt,
        referenceImages,
      };
    }

    this.ctx.logger.warn(
      { err: result.error },
      "Failed to generate image prompt for scrapbook memory",
    );
    return null;
  }

  private createEditButtonRow(messageId: string): ActionRowBuilder<ButtonBuilder> {
    const editButton = new ButtonBuilder()
      .setCustomId(`scrapbook-edit-${messageId}`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Primary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(editButton);
  }

  private async handleEditButton(interaction: ButtonInteraction): Promise<void> {
    const messageId = interaction.customId.replace("scrapbook-edit-", "");
    const imageData = this.imageDataMap.get(messageId);

    if (!imageData) {
      await interaction.reply({
        content: "This image has expired or cannot be edited.",
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`scrapbook-edit-modal-${messageId}`)
      .setTitle("Edit Scrapbook Image");

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

  private async handleEditModal(interaction: ModalSubmitInteraction): Promise<void> {
    const messageId = interaction.customId.replace("scrapbook-edit-modal-", "");
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
      aspectRatio: "16:9",
    };

    const result = await this.ctx.openai.generateImage(imageOptions);
    await result.match(
      async ({ buffer }) => {
        await message.edit({
          content: "",
          files: [
            {
              attachment: buffer,
              name: "scrapbook-memory.png",
              description: newPrompt,
            },
          ],
          components: [this.createEditButtonRow(messageId)],
        });

        this.imageDataMap.set(messageId, {
          prompt: newPrompt,
          effectivePrompt,
          referenceImages,
          buffer,
        });

        await interaction.deleteReply();
      },
      async (error) => {
        this.ctx.logger.error({ err: error }, "Scrapbook image editing failed");
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
