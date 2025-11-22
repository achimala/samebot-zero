import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  Message,
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
import { Octokit } from "@octokit/rest";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { CursorClient } from "../cursor/client";

const REPOSITORY = "achimala/samebot-zero";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100;

interface PendingMergeData {
  channelId: string;
  messageId: string;
  prUrl: string;
}

export class AgentLaunchFeature implements Feature {
  private ctx!: RuntimeContext;
  private cursorClient!: CursorClient;
  private pendingMerges = new Map<string, PendingMergeData>();

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
        if (interaction.customId.startsWith("merge-")) {
          void this.handleMergeButton(interaction);
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith("followup-modal-")) {
          void this.handleFollowUpModal(interaction);
        }
        if (interaction.customId.startsWith("github-token-modal-")) {
          void this.handleGitHubTokenModal(interaction);
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
        if (status.status === "FINISHED" && !prUrl && attempts < 30) {
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
      .setTitle("Cursor Agent")
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
          value: prUrl
            ? "✅ Completed - PR has been created!"
            : "✅ Completed - Creating PR...",
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

          const buttons: ButtonBuilder[] = [followUpButton];

          if (prUrl) {
            const mergeButton = new ButtonBuilder()
              .setCustomId(`merge-${prUrl}`)
              .setLabel("Merge PR")
              .setStyle(ButtonStyle.Success);
            buttons.push(mergeButton);
          }

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            buttons,
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

  private async handleMergeButton(interaction: ButtonInteraction) {
    const prUrl = interaction.customId.replace("merge-", "");
    const discordUserId = interaction.user.id;

    const githubToken = await this.ctx.supabase.getGitHubToken(discordUserId);

    if (!githubToken) {
      const messageId = interaction.message.id;
      const channelId = interaction.channelId;
      const mergeId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      this.pendingMerges.set(mergeId, {
        channelId,
        messageId,
        prUrl,
      });

      const modal = new ModalBuilder()
        .setCustomId(`github-token-modal-${mergeId}`)
        .setTitle("GitHub Token Required");

      const linkInput = new TextInputBuilder()
        .setCustomId("github-token-link")
        .setLabel("Create GitHub Token (click to copy)")
        .setStyle(TextInputStyle.Short)
        .setValue("https://github.com/settings/personal-access-tokens/new")
        .setRequired(false)
        .setMaxLength(100);

      const instructionsInput = new TextInputBuilder()
        .setCustomId("github-token-instructions")
        .setLabel("Instructions")
        .setStyle(TextInputStyle.Paragraph)
        .setValue(
          "Token needs 'Contents: Write' and 'Pull requests: Write'. Best: select 'repo' scope (full control).",
        )
        .setRequired(false)
        .setMaxLength(500);

      const tokenInput = new TextInputBuilder()
        .setCustomId("github-token")
        .setLabel("GitHub Personal Access Token")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("ghp_xxxxxxxxxxxx")
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(200);

      const linkRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
        linkInput,
      );
      const instructionsRow =
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          instructionsInput,
        );
      const tokenRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
        tokenInput,
      );

      modal.addComponents(linkRow, instructionsRow, tokenRow);

      await interaction.showModal(modal);
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    await this.mergePr(interaction, prUrl, githubToken);
  }

  private async handleGitHubTokenModal(interaction: ModalSubmitInteraction) {
    const mergeId = interaction.customId.replace("github-token-modal-", "");
    const mergeData = this.pendingMerges.get(mergeId);

    if (!mergeData) {
      await interaction.reply({
        content: "❌ Invalid or expired merge request. Please try again.",
        ephemeral: true,
      });
      return;
    }

    this.pendingMerges.delete(mergeId);

    const { channelId, messageId, prUrl } = mergeData;
    const githubToken = interaction.fields.getTextInputValue("github-token");
    const discordUserId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const saved = await this.ctx.supabase.setGitHubToken(
      discordUserId,
      githubToken,
    );

    if (!saved) {
      await interaction.editReply({
        content: "❌ Failed to save GitHub token. Please try again.",
      });
      return;
    }

    await interaction.editReply({
      content: "✅ GitHub token saved! Merging PR...",
    });

    let message: Message | undefined = interaction.message ?? undefined;
    if (!message) {
      try {
        const channel = await this.ctx.discord.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          const fetchedMessage = await channel.messages.fetch(messageId);
          message = fetchedMessage ?? undefined;
        }
      } catch (error) {
        this.ctx.logger.warn(
          { err: error, channelId, messageId },
          "Failed to fetch message for update",
        );
      }
    }

    await this.mergePr(interaction, prUrl, githubToken, message);
  }

  private async mergePr(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    prUrl: string,
    githubToken: string,
    messageOverride?: Message,
  ) {
    const prMatch = prUrl.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/,
    );

    if (!prMatch || !prMatch[1] || !prMatch[2] || !prMatch[3]) {
      if (interaction.isButton()) {
        await interaction.editReply({
          content: "❌ Invalid PR URL format",
        });
      }
      return;
    }

    const owner = prMatch[1];
    const repo = prMatch[2];
    const prNumber = prMatch[3];

    const githubClient = new Octokit({
      auth: githubToken,
    });

    try {
      const pullNumberInt = Number.parseInt(prNumber, 10);

      const pr = await githubClient.pulls.get({
        owner,
        repo,
        pull_number: pullNumberInt,
      });

      if (pr.data.draft) {
        try {
          const getPrNodeIdQuery = `
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) {
                  id
                }
              }
            }
          `;

          const nodeIdResponse = (await githubClient.graphql(getPrNodeIdQuery, {
            owner,
            repo,
            number: pullNumberInt,
          })) as { repository: { pullRequest: { id: string } } };

          const nodeId = nodeIdResponse.repository.pullRequest.id;

          const markReadyMutation = `
            mutation($pullRequestId: ID!) {
              markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) {
                pullRequest {
                  id
                  isDraft
                }
              }
            }
          `;

          await githubClient.graphql(markReadyMutation, {
            pullRequestId: nodeId,
          });
        } catch (updateError) {
          const updateErrorMessage =
            updateError instanceof Error
              ? updateError.message
              : String(updateError);
          if (updateErrorMessage.includes("Resource not accessible")) {
            throw new Error(
              "PR is a draft and token lacks permission to convert it. Please mark the PR as ready manually or grant 'Pull requests: Write' permission to your token.",
            );
          }
          throw updateError;
        }
      }

      await githubClient.pulls.merge({
        owner,
        repo,
        pull_number: pullNumberInt,
        merge_method: "squash",
      });

      if (interaction.isButton()) {
        await interaction.editReply({
          content: `✅ Successfully merged PR #${prNumber}`,
        });
      }

      const message = messageOverride ?? interaction.message;
      if (message && !message.partial && message.embeds[0]) {
        const embed = message.embeds[0];
        const updatedEmbed = EmbedBuilder.from(embed).addFields({
          name: "Merge Status",
          value: "✅ Merged",
        });

        const filteredComponents: ActionRowBuilder<ButtonBuilder>[] = [];
        for (const row of message.components) {
          if (row.type === 1) {
            const filteredButtons: ButtonBuilder[] = [];
            for (const component of row.components) {
              if (component.type === 2 && component.customId) {
                if (!component.customId.startsWith("merge-")) {
                  filteredButtons.push(ButtonBuilder.from(component));
                }
              } else if (component.type === 2) {
                filteredButtons.push(ButtonBuilder.from(component));
              }
            }
            if (filteredButtons.length > 0) {
              filteredComponents.push(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  filteredButtons,
                ),
              );
            }
          }
        }

        await message.edit({
          embeds: [updatedEmbed],
          components: filteredComponents,
        });
      }
    } catch (error) {
      this.ctx.logger.error({ err: error, prUrl }, "Failed to merge PR");
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (interaction.isButton()) {
        await interaction.editReply({
          content: `❌ Failed to merge PR: ${errorMessage}`,
        });
      }
    }
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
