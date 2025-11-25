import Fuse from "fuse.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

const TIGHT_MATCH_THRESHOLD = 0.2;

export class RememberImageFeature implements Feature {
  private ctx!: RuntimeContext;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      if (interaction.commandName !== "rememberimage") {
        return;
      }
      void this.handleRememberImage(interaction);
    });
  }

  private async handleRememberImage(interaction: ChatInputCommandInteraction) {
    const entityName = interaction.options.getString("name", true);
    const imageAttachment = interaction.options.getAttachment("image", true);

    if (!imageAttachment.contentType?.startsWith("image/")) {
      await interaction.reply({
        content: "Please provide a valid image file",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const normalizedName = this.normalizeEntityName(entityName);
    if (normalizedName.length < 2) {
      await interaction.editReply({
        content: "Entity name must be at least 2 characters",
      });
      return;
    }

    const existingFolders = await this.ctx.supabase.listEntityFolders();
    const targetFolder = this.findMatchingFolder(
      normalizedName,
      existingFolders,
    );

    const imageBuffer = await this.fetchImageAsBuffer(imageAttachment.url);
    if (!imageBuffer) {
      await interaction.editReply({
        content: "Failed to download the image",
      });
      return;
    }

    const result = await this.ctx.supabase.uploadEntityImage(
      targetFolder,
      imageBuffer,
      imageAttachment.contentType,
    );

    if (!result) {
      await interaction.editReply({
        content: "Failed to save the reference image",
      });
      return;
    }

    const isNewEntity = !existingFolders.includes(targetFolder);
    const existingFiles =
      await this.ctx.supabase.listFilesInFolder(targetFolder);
    const imageCount = existingFiles.length;

    if (isNewEntity) {
      await interaction.editReply({
        content: `Created new entity **${targetFolder}** with 1 reference image. Use this name in image/emoji prompts to include their likeness!`,
      });
    } else if (targetFolder !== normalizedName) {
      await interaction.editReply({
        content: `Added reference image to existing entity **${targetFolder}** (matched from "${entityName}"). Now has ${imageCount} reference image${imageCount === 1 ? "" : "s"}.`,
      });
    } else {
      await interaction.editReply({
        content: `Added reference image to **${targetFolder}**. Now has ${imageCount} reference image${imageCount === 1 ? "" : "s"}.`,
      });
    }

    this.ctx.logger.info(
      {
        entityName: targetFolder,
        inputName: entityName,
        isNewEntity,
        imageCount,
        userId: interaction.user.id,
      },
      "Added entity reference image",
    );
  }

  private normalizeEntityName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private findMatchingFolder(
    normalizedName: string,
    existingFolders: string[],
  ): string {
    if (existingFolders.length === 0) {
      return normalizedName;
    }

    if (existingFolders.includes(normalizedName)) {
      return normalizedName;
    }

    const fuse = new Fuse(existingFolders, {
      threshold: TIGHT_MATCH_THRESHOLD,
      includeScore: true,
    });

    const results = fuse.search(normalizedName);
    if (results.length > 0 && results[0]!.score !== undefined) {
      const topMatch = results[0]!;
      this.ctx.logger.info(
        {
          inputName: normalizedName,
          matchedFolder: topMatch.item,
          score: topMatch.score,
        },
        "Fuzzy matched to existing entity folder",
      );
      return topMatch.item;
    }

    return normalizedName;
  }

  private async fetchImageAsBuffer(url: string): Promise<Buffer | null> {
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      this.ctx.logger.warn({ err: error, url }, "Failed to fetch image");
      return null;
    }
  }
}
