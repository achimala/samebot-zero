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
import type { ResultAsync } from "neverthrow";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { CursorClient, prUrlOf, type StartedRun } from "../cursor/client";
import {
  REPOSITORY,
  closePullRequest,
  listAgentPullRequests,
  mergePullRequest,
  pullNumberFromUrl,
} from "../github/pull-requests";

const MISSING_GITHUB_TOKEN =
  "has no GitHub token saved. They need to press Merge PR on any coding agent's status message once to save one.";

type StatusPayload = {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};
type StatusUpdate = (payload: StatusPayload) => Promise<unknown>;

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
      REPOSITORY,
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
    await this.start(
      instructions,
      () => this.cursorClient.launchAgent(instructions),
      (payload) => interaction.editReply(payload),
    );
  }

  /**
   * Starts an agent from a chat request and posts its status embed to the
   * channel. Resolves once the agent has started; the run is tracked in the
   * background.
   */
  launchFromChat(channelId: string, task: string, prompt: string) {
    return this.startInChannel(channelId, task, () =>
      this.cursorClient.launchAgent(prompt),
    );
  }

  /** Sends extra instructions to an existing agent as a follow-up run. */
  amendFromChat(channelId: string, agentId: string, instructions: string) {
    return this.startInChannel(channelId, instructions, () =>
      this.cursorClient.addFollowUp(agentId, instructions),
    );
  }

  /** Recent agents on this repo and their open PRs, as text for the model. */
  async listForChat(): Promise<string> {
    const [agentsResult, pullRequestsResult] = await Promise.all([
      this.cursorClient.listAgents(),
      listAgentPullRequests(),
    ]);
    const agentsText = agentsResult.match(
      (agents) =>
        agents.length === 0
          ? "No coding agents."
          : agents
              .map(
                (agent) =>
                  `- ${agent.agentId} (${agent.status ?? "unknown"}, started ${agent.createdAt ? new Date(agent.createdAt).toISOString() : "unknown"}): ${agent.name}`,
              )
              .join("\n"),
      (error) => `Failed to list agents: ${error.message}`,
    );
    const pullRequestsText = pullRequestsResult.match(
      (pullRequests) =>
        pullRequests.length === 0
          ? "No open coding agent PRs."
          : pullRequests
              .map(
                (pullRequest) =>
                  `- #${pullRequest.number}${pullRequest.draft ? " (draft)" : ""}: ${pullRequest.title} ${pullRequest.url}`,
              )
              .join("\n"),
      (error) => `Failed to list PRs: ${error.message}`,
    );
    return `Coding agents, newest first:\n${agentsText}\n\nOpen coding agent PRs:\n${pullRequestsText}`;
  }

  async cancelFromChat(agentId: string): Promise<string> {
    const result = await this.cursorClient.cancelAgent(agentId);
    return result.match(
      (cancelledCount) =>
        cancelledCount === 0
          ? `Agent ${agentId} has nothing running.`
          : `Cancelled agent ${agentId}.`,
      (error) => `Failed to cancel agent ${agentId}: ${error.message}`,
    );
  }

  /** Merges with the GitHub token of the person who asked. */
  mergeFromChat(discordUserId: string, authorName: string, pullNumber: number) {
    return this.withGitHubToken(
      discordUserId,
      authorName,
      (githubToken) => mergePullRequest(githubToken, pullNumber),
      `Merged PR #${pullNumber}.`,
      `Failed to merge PR #${pullNumber}`,
    );
  }

  /** Closes with the GitHub token of the person who asked. */
  closeFromChat(discordUserId: string, authorName: string, pullNumber: number) {
    return this.withGitHubToken(
      discordUserId,
      authorName,
      (githubToken) => closePullRequest(githubToken, pullNumber),
      `Closed PR #${pullNumber} and deleted its branch.`,
      `Failed to close PR #${pullNumber}`,
    );
  }

  private async withGitHubToken(
    discordUserId: string,
    authorName: string,
    action: (githubToken: string) => ResultAsync<void, Error>,
    successText: string,
    failureText: string,
  ): Promise<string> {
    const githubToken = await this.ctx.supabase.getGitHubToken(discordUserId);
    if (!githubToken) {
      return `${authorName} ${MISSING_GITHUB_TOKEN}`;
    }
    const result = await action(githubToken);
    return result.match(
      () => successText,
      (error) => {
        this.ctx.logger.error({ err: error }, failureText);
        return `${failureText}: ${error.message}`;
      },
    );
  }

  private async startInChannel(
    channelId: string,
    task: string,
    startRun: () => ResultAsync<StartedRun, Error>,
  ): Promise<string> {
    const channel = await this.ctx.discord.channels.fetch(channelId);
    if (!channel || !channel.isSendable()) {
      return "Could not post to this channel.";
    }
    let message: Message | undefined;
    const update: StatusUpdate = async (payload) => {
      if (message) {
        await message.edit(payload);
      } else {
        message = await channel.send(payload);
      }
    };
    return new Promise((resolve) => {
      void this.start(task, startRun, update, resolve);
    });
  }

  /**
   * Starts a run and keeps its status embed up to date. `onStarted` fires as
   * soon as the run starts or fails to.
   */
  private async start(
    task: string,
    startRun: () => ResultAsync<StartedRun, Error>,
    update: StatusUpdate,
    onStarted?: (outcome: string) => void,
  ) {
    try {
      await update(this.statusPayload("pending", task));

      const startResult = await startRun();
      if (startResult.isErr()) {
        onStarted?.(`Failed to start agent: ${startResult.error.message}`);
        await update(
          this.statusPayload("failed", task, undefined, startResult.error.message),
        );
        return;
      }
      onStarted?.(
        `Started coding agent ${startResult.value.agentId}; its status and PR link are posted in the channel.`,
      );
      await this.reportRun(update, startResult.value, task);
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Agent start failed");
      onStarted?.("Failed to start agent.");
    }
  }

  /** Shows the run as running, then waits for it and shows the outcome. */
  private async reportRun(
    update: StatusUpdate,
    { agentId, run }: StartedRun,
    task: string,
  ) {
    await update(this.statusPayload("running", task));

    const result = await this.cursorClient.waitForRun(run);
    if (result.isErr()) {
      await update(
        this.statusPayload("failed", task, undefined, result.error.message),
      );
      return;
    }

    const { status, error } = result.value;
    await update(
      status === "finished"
        ? this.statusPayload(
            "completed",
            task,
            prUrlOf(result.value),
            undefined,
            agentId,
          )
        : this.statusPayload(
            "failed",
            task,
            undefined,
            error?.message ?? `Agent run ${status}`,
          ),
    );
  }

  private statusPayload(
    ...args: Parameters<AgentLaunchFeature["createStatusEmbed"]>
  ): StatusPayload {
    const { embed, components } = this.createStatusEmbed(...args);
    return { embeds: [embed], components: components ?? [] };
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
      .setDescription(`**Instructions:** ${instructions}`.slice(0, 4096))
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
    const pullNumber = pullNumberFromUrl(prUrl);
    if (pullNumber === null) {
      await interaction.editReply({ content: "❌ Invalid PR URL format" });
      return;
    }

    const mergeResult = await mergePullRequest(githubToken, pullNumber);
    if (mergeResult.isErr()) {
      this.ctx.logger.error({ err: mergeResult.error, prUrl }, "Failed to merge PR");
      await interaction.editReply({
        content: `❌ Failed to merge PR: ${mergeResult.error.message}`,
      });
      return;
    }

    await interaction.editReply({
      content: `✅ Successfully merged PR #${pullNumber}`,
    });

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
              if (
                !component.customId.startsWith("merge-") &&
                !component.customId.startsWith("followup-")
              ) {
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
  }

  private async handleFollowUpModal(interaction: ModalSubmitInteraction) {
    const agentId = interaction.customId.replace("followup-modal-", "");
    const instructions = interaction.fields.getTextInputValue(
      "followup-instructions",
    );

    await interaction.deferReply();
    await this.start(
      instructions,
      () => this.cursorClient.addFollowUp(agentId, instructions),
      (payload) => interaction.editReply(payload),
    );
  }
}
