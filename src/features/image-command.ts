import type { ChatInputCommandInteraction } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { EntityResolver } from "../utils/entity-resolver";

export class ImageCommandFeature implements Feature {
  private ctx!: RuntimeContext;
  private entityResolver!: EntityResolver;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.entityResolver = new EntityResolver(context.supabase, context.logger);
    context.discord.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "img") return;
      void this.handleImage(interaction);
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
