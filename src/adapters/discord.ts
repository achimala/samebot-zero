import type { Client, GuildEmoji, Message, GuildChannel } from "discord.js";
import { ResultAsync } from "neverthrow";
import type { Logger } from "pino";
import type { ToolResult, IncomingMessage } from "../agent/types";
import { Errors } from "../core/errors";
import type { DiscordMessenger } from "../discord/messenger";

export class DiscordAdapter {
  constructor(
    private readonly client: Client,
    private readonly messenger: DiscordMessenger,
    private readonly customEmoji: Map<string, GuildEmoji>,
    private readonly logger: Logger,
  ) {}

  async sendMessage(
    channelId: string,
    content: string,
  ): Promise<{ messageId: string }> {
    const result = await this.messenger.sendToChannel(channelId, content);

    return result.match(
      () => {
        return { messageId: `sent_${Date.now()}` };
      },
      (error) => {
        this.logger.error({ err: error }, "Failed to send message");
        return { messageId: "" };
      },
    );
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.fetchChannel(channelId);
    if (channel && "sendTyping" in channel) {
      await (channel as { sendTyping: () => Promise<void> }).sendTyping();
    }
  }

  async react(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<ToolResult> {
    const message = await this.fetchMessage(channelId, messageId);
    if (!message) {
      return { success: false, error: "Message not found" };
    }

    const result = await ResultAsync.fromPromise(
      message.react(emoji),
      (error) => {
        this.logger.warn({ err: error, emoji }, "Failed to react");
        return Errors.discord("Unable to react");
      },
    );

    return result.match(
      () => ({ success: true as const, message: "Reacted successfully" }),
      () => ({ success: false as const, error: "Failed to react" }),
    );
  }

  async sendImage(
    channelId: string,
    buffer: Buffer,
    filename: string,
    description?: string,
  ): Promise<ToolResult> {
    const result = await this.messenger.sendBuffer(
      channelId,
      buffer,
      filename,
      description,
    );

    return result.match(
      () => ({ success: true as const, message: "Image sent successfully" }),
      (error) => ({ success: false as const, error: error.message }),
    );
  }

  async sendPlaceholderMessage(
    channelId: string,
    prompt: string,
  ): Promise<{ messageId: string } | null> {
    const progressIndicators = ["⏳", "🎨", "✨"];
    const indicator =
      progressIndicators[Math.floor(Math.random() * progressIndicators.length)];
    const placeholderText = `${indicator} generating...`;

    const result = await this.messenger.sendToChannelWithId(
      channelId,
      placeholderText,
    );

    return result.match(
      (value) => ({ messageId: value.messageId }),
      () => null,
    );
  }

  async editMessageWithImage(
    channelId: string,
    messageId: string,
    buffer: Buffer,
    filename: string,
    description?: string,
  ): Promise<ToolResult> {
    const result = await this.messenger.editMessageWithFiles(
      channelId,
      messageId,
      buffer,
      filename,
      description,
    );

    return result.match(
      () => ({
        success: true as const,
        message: "Image updated successfully",
      }),
      (error) => ({ success: false as const, error: error.message }),
    );
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<ToolResult> {
    const result = await this.messenger.editMessage(
      channelId,
      messageId,
      content,
    );

    return result.match(
      () => ({
        success: true as const,
        message: "Message updated successfully",
      }),
      (error) => ({ success: false as const, error: error.message }),
    );
  }

  resolveEmoji(emojiInput: string): string | null {
    const trimmed = emojiInput.trim();

    if (trimmed.length === 0) {
      return null;
    }

    if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
      const customEmojiMatch = trimmed.match(/^<a?:([^:]+):(\d+)>$/);
      if (customEmojiMatch) {
        return trimmed;
      }
      return null;
    }

    const customEmoji = this.customEmoji.get(trimmed);
    if (customEmoji) {
      return customEmoji.animated
        ? `<a:${customEmoji.name}:${customEmoji.id}>`
        : `<:${customEmoji.name}:${customEmoji.id}>`;
    }

    return trimmed;
  }

  async getMessageById(
    channelId: string,
    messageId: string,
  ): Promise<{ id: string } | null> {
    const message = await this.fetchMessage(channelId, messageId);
    if (message) {
      return { id: message.id };
    }
    return null;
  }

  async enrichMessageContent(message: Message): Promise<{
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
        await ResultAsync.fromPromise(fetch(attachment.url), (error) => {
          this.logger.error(
            { err: error, url: attachment.url },
            "Failed to fetch image",
          );
          return Errors.discord("Unable to fetch image");
        })
          .andThen((response) => {
            if (!response.ok) {
              this.logger.warn(
                { url: attachment.url, status: response.status },
                "Failed to fetch image",
              );
              return ResultAsync.fromSafePromise<string>(
                Promise.reject(new Error("Response not ok")),
              );
            }
            return ResultAsync.fromPromise(response.arrayBuffer(), (error) => {
              this.logger.error(
                { err: error, url: attachment.url },
                "Failed to read image buffer",
              );
              return Errors.discord("Unable to read image buffer");
            }).map((buffer) => {
              const base64 = Buffer.from(buffer).toString("base64");
              const mimeType = attachment.contentType || "image/jpeg";
              return `data:${mimeType};base64,${base64}`;
            });
          })
          .match(
            (base64Image) => {
              images.push(base64Image);
            },
            () => {},
          );
      }
    }

    return {
      content: content.trim() || "(silent)",
      images,
    };
  }

  async toIncomingMessage(
    message: Message,
    botUserId?: string,
  ): Promise<IncomingMessage> {
    const enriched = await this.enrichMessageContent(message);
    const isDm = !message.inGuild();

    return {
      id: message.id,
      content: enriched.content,
      authorId: message.author.id,
      authorName: message.author.displayName || message.author.username,
      channelId: message.channelId,
      timestamp: message.createdTimestamp,
      images: enriched.images,
      isDm,
      mentionsBotId: botUserId ? message.mentions.users.has(botUserId) : false,
    };
  }

  async fetchRecentMessages(
    channelId: string,
    limit: number,
    before?: string,
  ): Promise<Message[]> {
    const cachedChannel = this.client.channels.cache.get(channelId);
    const channel =
      cachedChannel || (await this.client.channels.fetch(channelId));

    if (!channel || !channel.isTextBased()) {
      return [];
    }

    const fetchOptions: { limit: number; before?: string } = { limit };
    if (before) {
      fetchOptions.before = before;
    }

    const messages = await channel.messages.fetch(fetchOptions);
    return Array.from(messages.values());
  }

  private async fetchChannel(channelId: string) {
    const cachedChannel = this.client.channels.cache.get(channelId);
    if (cachedChannel) {
      return cachedChannel;
    }
    try {
      return await this.client.channels.fetch(channelId);
    } catch {
      return null;
    }
  }

  private async fetchMessage(
    channelId: string,
    messageId: string,
  ): Promise<Message | null> {
    const cachedChannel = this.client.channels.cache.get(channelId);
    const channel =
      cachedChannel || (await this.client.channels.fetch(channelId));

    if (!channel || !channel.isTextBased()) {
      return null;
    }

    try {
      return await channel.messages.fetch(messageId);
    } catch {
      this.logger.warn(
        { channelId, messageId },
        "Failed to find message by ID",
      );
      return null;
    }
  }
}
