import type {
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
} from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { EmojiGenerator, type ReferenceImage } from "../utils/emoji-generator";

const ROBOT_EMOJI = "🤖";
const PROGRESS_EMOJI = "⏳";

interface EmojiPromptResponse {
  prompt: string;
}

interface MessageContext {
  text: string;
  images: ReferenceImage[];
}

export class RobotEmojiReactFeature implements Feature {
  private ctx!: RuntimeContext;
  private emojiGenerator!: EmojiGenerator;
  private inProgress = new Set<string>();

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.emojiGenerator = new EmojiGenerator(context);
    context.discord.on("messageReactionAdd", (reaction, user) => {
      void this.handleReactionAdd(reaction, user);
    });
  }

  private async handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ) {
    if (user.bot) {
      return;
    }

    const emojiName = reaction.emoji.name;
    if (emojiName !== ROBOT_EMOJI) {
      return;
    }

    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
      } catch (error) {
        this.ctx.logger.warn(
          { err: error },
          "Failed to fetch partial reaction",
        );
        return;
      }
    }

    const message = reaction.message;
    if (message.partial) {
      try {
        await message.fetch();
      } catch (error) {
        this.ctx.logger.warn({ err: error }, "Failed to fetch partial message");
        return;
      }
    }

    if (this.inProgress.has(message.id)) {
      this.ctx.logger.debug(
        { messageId: message.id },
        "Emoji generation already in progress",
      );
      return;
    }

    this.inProgress.add(message.id);

    try {
      await this.generateContextualEmoji(message as Message);
    } finally {
      this.inProgress.delete(message.id);
    }
  }

  private async generateContextualEmoji(message: Message) {
    let progressReaction: MessageReaction | null = null;

    try {
      progressReaction = await message.react(PROGRESS_EMOJI);
    } catch (error) {
      this.ctx.logger.warn({ err: error }, "Failed to add progress emoji");
    }

    try {
      const context = await this.buildMessageContext(message);
      const promptResult = await this.generateEmojiPrompt(context);

      if (promptResult.isErr()) {
        this.ctx.logger.error(
          { err: promptResult.error },
          "Failed to generate emoji prompt",
        );
        await this.removeProgressEmoji(message, progressReaction);
        return;
      }

      const prompt = promptResult.value.prompt;
      this.ctx.logger.info(
        { prompt, messageId: message.id, imageCount: context.images.length },
        "Generated emoji prompt",
      );

      const referenceImages =
        context.images.length > 0 ? context.images : undefined;
      const preview = await this.emojiGenerator.generatePreview(
        prompt,
        referenceImages,
      );

      await this.removeProgressEmoji(message, progressReaction);

      if (!preview) {
        this.ctx.logger.error(
          { messageId: message.id },
          "Failed to generate emoji preview",
        );
        return;
      }

      const previewId =
        await this.emojiGenerator.postPreviewWithButtons(preview);

      if (!previewId) {
        this.ctx.logger.error(
          { messageId: message.id },
          "Failed to post emoji preview",
        );
        return;
      }

      this.ctx.logger.info(
        { messageId: message.id, previewId, emojiName: preview.name },
        "Posted emoji preview with buttons",
      );
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Error in emoji generation flow");
      await this.removeProgressEmoji(message, progressReaction);
    }
  }

  private async removeProgressEmoji(
    message: Message,
    progressReaction: MessageReaction | null,
  ) {
    if (!progressReaction) {
      return;
    }
    try {
      await message.reactions.cache
        .get(PROGRESS_EMOJI)
        ?.users.remove(this.ctx.discord.user?.id);
    } catch (error) {
      this.ctx.logger.warn({ err: error }, "Failed to remove progress emoji");
    }
  }

  private async buildMessageContext(message: Message): Promise<MessageContext> {
    const lines: string[] = [];
    const images: ReferenceImage[] = [];

    try {
      const channel = message.channel;
      if (channel.isTextBased() && "messages" in channel) {
        const beforeMessages = await channel.messages.fetch({
          limit: 5,
          before: message.id,
        });

        const sortedBefore = Array.from(beforeMessages.values()).reverse();
        for (const msg of sortedBefore) {
          if (!msg.author.bot) {
            lines.push(`${msg.author.displayName}: ${msg.content}`);
            await this.collectImages(msg, images);
          }
        }
      }
    } catch (error) {
      this.ctx.logger.warn({ err: error }, "Failed to fetch context messages");
    }

    const authorName =
      message.member?.displayName ||
      message.author.displayName ||
      message.author.username;
    lines.push(`[TARGET MESSAGE] ${authorName}: ${message.content}`);
    await this.collectImages(message, images);

    return { text: lines.join("\n"), images };
  }

  private async collectImages(message: Message, images: ReferenceImage[]) {
    for (const attachment of message.attachments.values()) {
      if (!attachment.contentType?.startsWith("image/")) {
        continue;
      }
      try {
        const response = await fetch(attachment.url);
        const arrayBuffer = await response.arrayBuffer();
        const data = Buffer.from(arrayBuffer).toString("base64");
        images.push({ data, mimeType: attachment.contentType });
      } catch (error) {
        this.ctx.logger.warn(
          { err: error, url: attachment.url },
          "Failed to fetch image attachment",
        );
      }
    }
  }

  private generateEmojiPrompt(context: MessageContext) {
    const systemContent = `You are generating a prompt for an emoji image based on conversation context.
The user has reacted with a robot emoji to request a custom emoji be generated.

Analyze the TARGET MESSAGE and its surrounding context (including any images) to determine what emoji would be most appropriate and fun.
Generate a short, clear image prompt (5-15 words) describing the emoji to create.

The prompt should describe a simple, recognizable image suitable for a Discord emoji.
Focus on the main subject/object/emotion that would make a good reaction emoji.
Be creative and contextually relevant - the emoji should feel like a natural reaction to the message.
${context.images.length > 0 ? "If images are present in the context, consider them when generating the emoji prompt." : ""}`;

    const imageUrls = context.images.map(
      (img) => `data:${img.mimeType};base64,${img.data}`,
    );

    const userMessage: { role: "user"; content: string; images?: string[] } = {
      role: "user",
      content: context.text,
    };
    if (imageUrls.length > 0) {
      userMessage.images = imageUrls;
    }

    return this.ctx.openai.chatStructured<EmojiPromptResponse>({
      messages: [
        {
          role: "system",
          content: systemContent,
        },
        userMessage,
      ],
      schema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "A short image prompt (5-15 words) for the emoji to generate",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      schemaName: "emojiPrompt",
      schemaDescription: "Generated emoji prompt based on message context",
    });
  }
}
