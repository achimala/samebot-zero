import type { ChatInputCommandInteraction } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { EmojiGenerator } from "../utils/emoji-generator";

export class SamebotEmojiFeature implements Feature {
  private ctx!: RuntimeContext;
  private emojiGenerator!: EmojiGenerator;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.emojiGenerator = new EmojiGenerator(context);
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

    await interaction.deferReply({ ephemeral: true });

    const prompt = interaction.options.getString("prompt", true);
    const result = await this.emojiGenerator.generate(prompt);

    if (!result) {
      await interaction.editReply({
        content: "Failed to generate emoji",
      });
      return;
    }

    await interaction.editReply({
      content: `Generated new :${result.name}: emoji! ${result.emoji}`,
    });
  }
}
