import type { ChatInputCommandInteraction } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

export class SamebotEmojiFeature implements Feature {
  private ctx!: RuntimeContext;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "samebot") return;
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
        content: "You need the 'Manage Emojis and Stickers' permission to use this command",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const prompt = "a simple, cute robot character icon, transparent background, minimal design, suitable as a Discord emoji";

    const result = await this.ctx.openai.generateImage({
      prompt,
      aspectRatio: "1:1",
      imageSize: "1K",
    });

    await result.match(
      async ({ buffer }) => {
        try {
          const existingEmoji = interaction.guild!.emojis.cache.find(
            (emoji) => emoji.name === "samebot",
          );

          if (existingEmoji) {
            await existingEmoji.delete();
            this.ctx.logger.info(
              { emojiId: existingEmoji.id },
              "Deleted existing samebot emoji",
            );
          }

          const createdEmoji = await interaction.guild!.emojis.create({
            attachment: buffer,
            name: "samebot",
          });

          this.ctx.logger.info(
            { emojiId: createdEmoji.id },
            "Created new samebot emoji",
          );

          await interaction.editReply({
            content: `Generated new :samebot: emoji! ${createdEmoji}`,
          });
        } catch (error) {
          this.ctx.logger.error(
            { err: error },
            "Failed to create emoji",
          );
          await interaction.editReply({
            content: "Failed to create emoji. Make sure the bot has 'Manage Emojis and Stickers' permission.",
          });
        }
      },
      async (error) => {
        this.ctx.logger.error({ err: error }, "Image generation failed");
        await interaction.editReply("Couldn't generate the emoji image, sorry");
      },
    );
  }
}
