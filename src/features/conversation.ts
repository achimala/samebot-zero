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
you keep responses short, rarely use emojis, and occasionally swear for comedic effect.
usually just respond very briefly, 10-20 words, conversationally. unless specifically asked for a lot of information or detail`;

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
    let context = this.contexts.get(key) ?? {
      history: [],
      isDm,
    };
    context.isDm = isDm;

    await this.backfillMessages(message.channelId, context, message.id);

    const enriched = await this.enrichContent(message);
    const formatted = `${
      message.author.displayName || message.author.username
    }: ${enriched.content}`;
    context.history.push({
      role: "user",
      content: formatted,
      images: enriched.images.length > 0 ? enriched.images : undefined,
      timestamp: message.createdTimestamp,
    });
    context.history = context.history.slice(-12);
    this.contexts.set(key, context);

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

  private async backfillMessages(
    channelId: string,
    context: ConversationState,
    beforeMessageId: string,
  ) {
    try {
      const channel =
        this.ctx.discord.channels.cache.get(channelId) ||
        (await this.ctx.discord.channels.fetch(channelId));
      if (!channel || !channel.isTextBased()) {
        return;
      }

      const existingMessageIds = new Set(
        context.history.map((msg) => msg.timestamp.toString()),
      );

      const messages = await channel.messages.fetch({
        limit: 50,
        before: beforeMessageId,
      });

      const newMessages: Array<{
        role: "user" | "assistant";
        content: string;
        timestamp: number;
      }> = [];

      for (const [messageId, msg] of messages) {
        if (msg.author.bot || msg.system) {
          if (msg.author.id === this.botUserId) {
            const content = msg.content || "(silent)";
            newMessages.push({
              role: "assistant",
              content,
              timestamp: msg.createdTimestamp,
            });
          }
          continue;
        }

        const messageKey = msg.createdTimestamp.toString();
        if (existingMessageIds.has(messageKey)) {
          continue;
        }

        const enriched = await this.enrichContent(msg);
        const formatted = `${
          msg.author.displayName || msg.author.username
        }: ${enriched.content}`;
        newMessages.push({
          role: "user",
          content: formatted,
          images: enriched.images.length > 0 ? enriched.images : undefined,
          timestamp: msg.createdTimestamp,
        });
      }

      if (newMessages.length > 0) {
        context.history.push(...newMessages);
        context.history.sort((a, b) => a.timestamp - b.timestamp);
        context.history = context.history.slice(-12);
      }
    } catch (error) {
      this.ctx.logger.error(
        { err: error, channelId },
        "Failed to backfill messages",
      );
    }
  }

  private async enrichContent(message: Message): Promise<{
    content: string;
    images: string[];
  }> {
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

    const images: string[] = [];
    if (message.attachments.size > 0) {
      const imageAttachments = Array.from(message.attachments.values()).filter(
        (attachment) => attachment.contentType?.startsWith("image"),
      );
      for (const attachment of imageAttachments) {
        try {
          const response = await fetch(attachment.url);
          if (!response.ok) {
            this.ctx.logger.warn(
              { url: attachment.url, status: response.status },
              "Failed to fetch image",
            );
            continue;
          }
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const mimeType = attachment.contentType || "image/jpeg";
          images.push(`data:${mimeType};base64,${base64}`);
        } catch (error) {
          this.ctx.logger.error(
            { err: error, url: attachment.url },
            "Failed to convert image to base64",
          );
        }
      }
    }

    return {
      content: content.trim() || "(silent)",
      images,
    };
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
