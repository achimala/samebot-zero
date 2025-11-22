import type { ChatInputCommandInteraction } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

export class ImageCommandFeature implements Feature {
  private ctx!: RuntimeContext;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "img") return;
      void this.handleImage(interaction);
    });
  }

  private async handleImage(interaction: ChatInputCommandInteraction) {
    const prompt = interaction.options.getString("prompt", true);
    await interaction.deferReply();
    const result = await this.ctx.openai.generateImage({ prompt });
    await result.match(
      async ({ buffer }) => {
        await interaction.editReply({
          content: `prompt: ${prompt}`,
          files: [
            {
              attachment: buffer,
              name: "samebot-image.png",
              description: prompt,
            },
          ],
        });
      },
      async (error) => {
        this.ctx.logger.error({ err: error }, "Image generation failed");
        await interaction.editReply("couldn't draw that, sorry");
      },
    );
  }
}
