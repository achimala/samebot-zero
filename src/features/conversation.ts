import type {
  Message,
  ChatInputCommandInteraction,
  GuildChannel,
} from "discord.js";
import { DateTime } from "luxon";
import { type Feature, type RuntimeContext } from "../core/runtime";
import type { ChatMessage } from "../openai/client";
import type { BotError } from "../core/errors";
import {
  ResponseDecision,
  type ConversationContext,
} from "../utils/response-decision";

const PERSONA = `you are samebot, a hyper-intelligent, lowercase-talking friend with a dry, sarcastic british tone.
you keep responses short, rarely use emojis, and occasionally swear for comedic effect.`;

interface ConversationState extends ConversationContext {
  lastResponseAt?: number;
}

export class ConversationFeature implements Feature {
  private ctx!: RuntimeContext;
  private botUserId?: string;
  private readonly contexts = new Map<string, ConversationState>();
  private responseDecision!: ResponseDecision;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.responseDecision = new ResponseDecision({
      openai: context.openai,
      logger: context.logger,
    });
    context.discord.once("ready", (client) => {
      this.botUserId = client.user.id;
      this.responseDecision = new ResponseDecision({
        openai: context.openai,
        botUserId: client.user.id,
        logger: context.logger,
      });
    });
    context.discord.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });
    context.discord.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "debug") {
        void this.handleDebug(interaction);
      }
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || message.system) {
      return;
    }
    if (!message.inGuild() && !message.channel.isDMBased()) {
      return;
    }

    const key = message.channelId || message.author.id;
    const isDm = !message.inGuild();
    const context = this.contexts.get(key) ?? {
      history: [],
      isDm,
    };
    context.isDm = isDm;
    this.contexts.set(key, context);

    const formatted = `${
      message.author.displayName || message.author.username
    }: ${this.enrichContent(message)}`;
    context.history.push({
      role: "user",
      content: formatted,
      timestamp: message.createdTimestamp,
    });
    context.history = context.history.slice(-12);

    if (!(await this.responseDecision.shouldRespond(message, context))) {
      return;
    }

    await (message.channel as { sendTyping: () => Promise<void> }).sendTyping();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `${PERSONA}\nCurrent date: ${DateTime.now().toISO()}\nRespond in lowercase only.`,
      },
      ...context.history.map(({ timestamp, ...msg }) => msg),
    ];

    const response = await this.ctx.openai.chat({
      messages,
      allowSearch: true,
    });
    await response.match(
      async (reply) => {
        context.history.push({
          role: "assistant",
          content: reply,
          timestamp: Date.now(),
        });
        context.history = context.history.slice(-12);
        context.lastResponseAt = Date.now();
        await this.ctx.messenger.sendToChannel(message.channelId, reply).match(
          async () => undefined,
          async (sendError: BotError) => {
            this.ctx.logger.error(
              { err: sendError },
              "Failed to deliver reply",
            );
          },
        );
      },
      async (error) => {
        this.ctx.logger.error(
          { err: error },
          "Failed to generate chat response",
        );
        if (error.type === "openai") {
          await this.ctx.messenger
            .sendToChannel(message.channelId, "something broke, brb")
            .match(
              async () => undefined,
              async (sendError: BotError) =>
                this.ctx.logger.error(
                  { err: sendError },
                  "Failed to send error message",
                ),
            );
        }
      },
    );
  }

  private enrichContent(message: Message) {
    let content = message.content || "";

    for (const user of message.mentions.users.values()) {
      let displayName = user.displayName || user.username;
      if (message.inGuild()) {
        const member = message.guild?.members.cache.get(user.id);
        if (member) {
          displayName = member.displayName;
        }
      }
      content = content.replace(
        new RegExp(`<@!?${user.id}>`, "g"),
        `@${displayName}`,
      );
    }

    if (message.inGuild()) {
      for (const role of message.mentions.roles.values()) {
        content = content.replace(
          new RegExp(`<@&${role.id}>`, "g"),
          `@${role.name}`,
        );
      }

      for (const channel of message.mentions.channels.values()) {
        const guildChannel = channel as GuildChannel;
        if (guildChannel.name) {
          content = content.replace(
            new RegExp(`<#${channel.id}>`, "g"),
            `#${guildChannel.name}`,
          );
        }
      }
    }

    if (message.attachments.size > 0) {
      const attachments = Array.from(message.attachments.values())
        .filter((attachment) => attachment.contentType?.startsWith("image"))
        .map((attachment) => attachment.url);
      if (attachments.length > 0) {
        content += `\nImages:\n${attachments.join("\n")}`;
      }
    }
    return content.trim() || "(silent)";
  }

  private async handleDebug(interaction: ChatInputCommandInteraction) {
    const key = interaction.channelId || interaction.user.id;
    const context = this.contexts.get(key);
    if (!context) {
      await interaction.reply({ content: "no context yet", ephemeral: true });
      return;
    }
    const payload = context.history
      .map((entry) => `${entry.role}: ${entry.content}`)
      .join("\n")
      .slice(-1900);
    await interaction.reply({
      content: `\`\`\`\n${payload}\n\`\`\``,
      ephemeral: true,
    });
  }
}
