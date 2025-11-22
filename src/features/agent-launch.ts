import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { CursorClient } from "../cursor/client";

const REPOSITORY = "achimala/samebot-zero";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100;

export class AgentLaunchFeature implements Feature {
  private ctx!: RuntimeContext;
  private cursorClient!: CursorClient;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.cursorClient = new CursorClient(
      context.config.cursorApiKey,
      context.logger,
    );
    context.discord.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "agent") return;
      void this.handleAgentLaunch(interaction);
    });
  }

  private async handleAgentLaunch(interaction: ChatInputCommandInteraction) {
    const instructions = interaction.options.getString("instructions", true);
    const branch = interaction.options.getString("branch") ?? undefined;

    await interaction.deferReply();

    const initialEmbed = this.createStatusEmbed("pending", instructions);
    const message = await interaction.editReply({
      embeds: [initialEmbed],
    });

    const launchResult = await this.cursorClient.launchAgent({
      repository: REPOSITORY,
      branch,
      instructions,
      model: "composer",
    });

    if (launchResult.isErr()) {
      const errorEmbed = this.createStatusEmbed(
        "failed",
        instructions,
        undefined,
        launchResult.error.message,
      );
      await interaction.editReply({ embeds: [errorEmbed] });
      return;
    }

    const agentStatus = launchResult.value;
    await this.pollAndUpdateStatus(
      message.id,
      interaction,
      agentStatus.id,
      instructions,
    );
  }

  private async pollAndUpdateStatus(
    messageId: string,
    interaction: ChatInputCommandInteraction,
    agentId: string,
    instructions: string,
  ) {
    let attempts = 0;

    while (attempts < MAX_POLL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const statusResult = await this.cursorClient.getAgentStatus(agentId);

      if (statusResult.isErr()) {
        const errorEmbed = this.createStatusEmbed(
          "failed",
          instructions,
          undefined,
          statusResult.error.message,
        );
        await interaction.editReply({ embeds: [errorEmbed] });
        return;
      }

      const status = statusResult.value;

      const embed = this.createStatusEmbed(
        status.status,
        instructions,
        status.prUrl,
        status.error,
      );

      await interaction.editReply({ embeds: [embed] });

      if (status.status === "completed" || status.status === "failed") {
        return;
      }

      attempts++;
    }

    const timeoutEmbed = this.createStatusEmbed(
      "failed",
      instructions,
      undefined,
      "Polling timeout - agent may still be running",
    );
    await interaction.editReply({ embeds: [timeoutEmbed] });
  }

  private createStatusEmbed(
    status: "pending" | "running" | "completed" | "failed",
    instructions: string,
    prUrl?: string,
    error?: string,
  ): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle("🤖 Cursor Agent Launch")
      .setDescription(`**Instructions:** ${instructions}`)
      .setColor(this.getStatusColor(status))
      .setTimestamp();

    switch (status) {
      case "pending":
        embed.addFields({
          name: "Status",
          value: "⏳ Pending - Agent is being initialized...",
        });
        break;
      case "running":
        embed.addFields({
          name: "Status",
          value: "🔄 Running - Agent is working on your request...",
        });
        break;
      case "completed":
        embed.addFields({
          name: "Status",
          value: "✅ Completed - PR has been created!",
        });
        if (prUrl) {
          embed.addFields({
            name: "Pull Request",
            value: `[View PR](${prUrl})`,
          });
        }
        break;
      case "failed":
        embed.addFields({
          name: "Status",
          value: "❌ Failed",
        });
        if (error) {
          embed.addFields({
            name: "Error",
            value: error.substring(0, 1024),
          });
        }
        break;
    }

    return embed;
  }

  private getStatusColor(
    status: "pending" | "running" | "completed" | "failed",
  ): number {
    switch (status) {
      case "pending":
        return 0x3498db;
      case "running":
        return 0xf39c12;
      case "completed":
        return 0x2ecc71;
      case "failed":
        return 0xe74c3c;
    }
  }
}
