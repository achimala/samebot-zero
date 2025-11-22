import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
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
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "agent") {
          void this.handleAgentLaunch(interaction);
        }
        return;
      }
      if (interaction.isButton()) {
        if (interaction.customId.startsWith("followup-")) {
          void this.handleFollowUpButton(interaction);
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith("followup-modal-")) {
          void this.handleFollowUpModal(interaction);
        }
        return;
      }
    });
  }

  private async handleAgentLaunch(interaction: ChatInputCommandInteraction) {
    const instructions = interaction.options.getString("instructions", true);

    await interaction.deferReply();

    const { embed: initialEmbed } = this.createStatusEmbed(
      "pending",
      instructions,
    );
    const message = await interaction.editReply({
      embeds: [initialEmbed],
    });

    const launchResult = await this.cursorClient.launchAgent({
      repository: REPOSITORY,
      instructions,
      model: "composer-1",
    });

    if (launchResult.isErr()) {
      const { embed: errorEmbed } = this.createStatusEmbed(
        "failed",
        instructions,
        undefined,
        launchResult.error.message,
      );
      await interaction.editReply({ embeds: [errorEmbed] });
      return;
    }

    const agentStatus = launchResult.value;
    const normalizedStatus = this.normalizeStatus(agentStatus.status);
    const { embed: initialStatusEmbed, components } = this.createStatusEmbed(
      normalizedStatus,
      instructions,
      agentStatus.target.prUrl,
      undefined,
      agentStatus.id,
    );
    await interaction.editReply({
      embeds: [initialStatusEmbed],
      components: components ?? [],
    });

    await this.pollAndUpdateStatus(
      message.id,
      interaction,
      agentStatus.id,
      instructions,
      false,
    );
  }

  private async pollAndUpdateStatus(
    messageId: string,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    agentId: string,
    instructions: string,
    isFollowUp: boolean = false,
  ) {
    let attempts = 0;
    let lastKnownPrUrl: string | undefined;
    let hasSeenRunningAfterFollowUp = false;

    while (attempts < MAX_POLL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const statusResult = await this.cursorClient.getAgentStatus(agentId);

      if (statusResult.isErr()) {
        const { embed: errorEmbed } = this.createStatusEmbed(
          "failed",
          instructions,
          undefined,
          statusResult.error.message,
        );
        await interaction.editReply({ embeds: [errorEmbed] });
        return;
      }

      const status = statusResult.value;

      const prUrl = status.target.prUrl ?? lastKnownPrUrl;
      if (status.target.prUrl) {
        lastKnownPrUrl = status.target.prUrl;
      }

      if (isFollowUp && status.status === "RUNNING") {
        hasSeenRunningAfterFollowUp = true;
      }

      let normalizedStatus = this.normalizeStatus(status.status);

      if (
        isFollowUp &&
        status.status === "FINISHED" &&
        !hasSeenRunningAfterFollowUp
      ) {
        normalizedStatus = "running";
      }

      this.ctx.logger.debug(
        {
          agentId: status.id,
          status: status.status,
          prUrl,
          normalizedStatus,
          autoCreatePr: status.target.autoCreatePr,
          target: status.target,
          isFollowUp,
          hasSeenRunningAfterFollowUp,
        },
        "Agent status update",
      );

      const { embed, components } = this.createStatusEmbed(
        normalizedStatus,
        instructions,
        prUrl,
        status.status === "FAILED" ? status.summary : undefined,
        status.id,
      );

      await interaction.editReply({
        embeds: [embed],
        components: components ?? [],
      });

      if (status.status === "FINISHED" || status.status === "FAILED") {
        if (
          isFollowUp &&
          status.status === "FINISHED" &&
          !hasSeenRunningAfterFollowUp
        ) {
          attempts++;
          continue;
        }
        if (
          status.status === "FINISHED" &&
          status.target.autoCreatePr &&
          !status.target.prUrl &&
          attempts < 10
        ) {
          attempts++;
          continue;
        }
        return;
      }

      attempts++;
    }

    const { embed: timeoutEmbed } = this.createStatusEmbed(
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
    agentId?: string,
  ): { embed: EmbedBuilder; components?: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
      .setTitle("🤖 Cursor Agent Launch")
      .setDescription(`**Instructions:** ${instructions}`)
      .setColor(this.getStatusColor(status))
      .setTimestamp();

    let components: ActionRowBuilder<ButtonBuilder>[] | undefined;

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
        if (agentId) {
          const followUpButton = new ButtonBuilder()
            .setCustomId(`followup-${agentId}`)
            .setLabel("Follow-Up")
            .setStyle(ButtonStyle.Primary);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            followUpButton,
          );
          components = [row];
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

    if (components) {
      return { embed, components };
    }
    return { embed };
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

  private normalizeStatus(
    status: "CREATING" | "RUNNING" | "FINISHED" | "FAILED",
  ): "pending" | "running" | "completed" | "failed" {
    switch (status) {
      case "CREATING":
        return "pending";
      case "RUNNING":
        return "running";
      case "FINISHED":
        return "completed";
      case "FAILED":
        return "failed";
    }
  }

  private async handleFollowUpButton(interaction: ButtonInteraction) {
    const agentId = interaction.customId.replace("followup-", "");

    const modal = new ModalBuilder()
      .setCustomId(`followup-modal-${agentId}`)
      .setTitle("Follow-Up");

    const instructionsInput = new TextInputBuilder()
      .setCustomId("followup-instructions")
      .setLabel("Follow-up Instructions")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Describe what you'd like the agent to do next...")
      .setRequired(true)
      .setMaxLength(2000);

    const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
      instructionsInput,
    );

    modal.addComponents(actionRow);

    await interaction.showModal(modal);
  }

  private async handleFollowUpModal(interaction: ModalSubmitInteraction) {
    const agentId = interaction.customId.replace("followup-modal-", "");
    const instructions = interaction.fields.getTextInputValue(
      "followup-instructions",
    );

    await interaction.deferReply();

    const { embed: pendingEmbed } = this.createStatusEmbed(
      "pending",
      instructions,
    );
    const message = await interaction.editReply({
      embeds: [pendingEmbed],
    });

    const followUpResult = await this.cursorClient.addFollowUp(
      agentId,
      instructions,
    );

    if (followUpResult.isErr()) {
      const { embed: errorEmbed } = this.createStatusEmbed(
        "failed",
        instructions,
        undefined,
        followUpResult.error.message,
      );
      await interaction.editReply({ embeds: [errorEmbed] });
      return;
    }

    const statusResult = await this.cursorClient.getAgentStatus(agentId);

    if (statusResult.isErr()) {
      const { embed: errorEmbed } = this.createStatusEmbed(
        "failed",
        instructions,
        undefined,
        statusResult.error.message,
      );
      await interaction.editReply({ embeds: [errorEmbed] });
      return;
    }

    const agentStatus = statusResult.value;
    let normalizedStatus = this.normalizeStatus(agentStatus.status);

    if (agentStatus.status === "FINISHED") {
      normalizedStatus = "running";
    }

    const statusEmbedResult = this.createStatusEmbed(
      normalizedStatus,
      instructions,
      agentStatus.target.prUrl,
      agentStatus.status === "FAILED" ? agentStatus.summary : undefined,
      agentStatus.id,
    );

    await interaction.editReply({
      embeds: [statusEmbedResult.embed],
      components: statusEmbedResult.components ?? [],
    });

    await this.pollAndUpdateStatus(
      message.id,
      interaction,
      agentId,
      instructions,
      true,
    );
  }
}
