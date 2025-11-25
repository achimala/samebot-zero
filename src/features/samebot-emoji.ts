import type { ChatInputCommandInteraction } from "discord.js";
import { okAsync } from "neverthrow";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { processEmojiImage } from "../utils/image-processing";

const MAX_EMOJI_SLOTS = 50;

interface EmojiNameResponse {
  name: string;
}

export class SamebotEmojiFeature implements Feature {
  private ctx!: RuntimeContext;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      if (interaction.commandName !== "emoji") {
        return;
      }
      void this.handleSamebotEmoji(interaction);
    });
  }

  private async handleSamebotEmoji(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server",
        ephemeral: true,
      });
      return;
    }

    if (!interaction.memberPermissions?.has("ManageEmojisAndStickers")) {
      await interaction.reply({
        content:
          "You need the 'Manage Emojis and Stickers' permission to use this command",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const prompt = interaction.options.getString("prompt", true);

    const emojiGuild = this.ctx.discord.guilds.cache.get(
      this.ctx.config.emojiGuildId,
    );
    if (!emojiGuild) {
      this.ctx.logger.error(
        { emojiGuildId: this.ctx.config.emojiGuildId },
        "Emoji guild not found",
      );
      await interaction.editReply({
        content: "Emoji guild not configured properly",
      });
      return;
    }

    const nameResult = await this.generateEmojiName(prompt);
    if (nameResult.isErr()) {
      this.ctx.logger.error({ err: nameResult.error }, "Failed to generate emoji name");
      await interaction.editReply({
        content: "Failed to generate emoji name",
      });
      return;
    }
    const emojiName = nameResult.value;

    const imageResult = await this.ctx.openai.generateImage({
      prompt: `${prompt}, solid bright magenta background (#FF00FF), minimal design, suitable as a Discord emoji`,
      aspectRatio: "1:1",
      imageSize: "1K",
    });

    await imageResult.match(
      async ({ buffer }) => {
        try {
          const processedBuffer = await processEmojiImage(buffer);

          const emojis = await emojiGuild.emojis.fetch();
          if (emojis.size >= MAX_EMOJI_SLOTS) {
            const oldestEmoji = emojis.reduce((oldest, current) =>
              oldest.id < current.id ? oldest : current,
            );
            await oldestEmoji.delete();
            this.ctx.logger.info(
              { emojiId: oldestEmoji.id, emojiName: oldestEmoji.name },
              "Deleted oldest emoji to make room",
            );
          }

          const createdEmoji = await emojiGuild.emojis.create({
            attachment: processedBuffer,
            name: emojiName,
          });

          this.ctx.logger.info(
            { emojiId: createdEmoji.id, emojiName: createdEmoji.name },
            "Created new emoji",
          );

          await interaction.editReply({
            content: `Generated new :${emojiName}: emoji! ${createdEmoji}`,
          });
        } catch (error) {
          this.ctx.logger.error({ err: error }, "Failed to create emoji");
          await interaction.editReply({
            content:
              "Failed to create emoji. Make sure the bot has 'Manage Emojis and Stickers' permission in the emoji guild.",
          });
        }
      },
      async (error) => {
        this.ctx.logger.error({ err: error }, "Image generation failed");
        await interaction.editReply("Couldn't generate the emoji image, sorry");
      },
    );
  }

  private generateEmojiName(prompt: string) {
    const sanitized = this.sanitizeEmojiName(prompt);
    if (sanitized.length >= 2 && sanitized.length <= 32) {
      return okAsync(sanitized);
    }

    return this.ctx.openai.chatStructured<EmojiNameResponse>({
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
    }).map((response) => this.sanitizeEmojiName(response.name));
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
