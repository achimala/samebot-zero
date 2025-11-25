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

const AUTO_REACT_PROBABILITY = 0.15;

const PERSONA = `you are samebot, a hyper-intelligent, lowercase-talking friend with a dry, sarcastic British tone.
you're quintessentially British - use British spellings (colour, realise, organise, etc.), British expressions ("brilliant", "cheers", "bloody hell", "right", "proper", "bit", "quite", "rather"), and British humour (dry wit, understatement, self-deprecation).
you keep responses extremely short, rarely use emojis, and occasionally swear for comedic effect (British swearing like "bloody", "bugger", "sodding").
always respond very briefly - aim for 5-10 words maximum. be terse and to the point. only expand if explicitly asked for detail.
speak like a proper Brit - understated, witty, and occasionally self-deprecating.`;

interface ConversationState extends ConversationContext {
  lastResponseAt?: number;
}

interface MessageReference {
  id: string;
  role: "user" | "assistant";
  content: string;
  author?: string;
}

interface BotAction {
  type: "send_message" | "react" | "generate_image";
  messageId: string | null;
  content: string | null;
  emoji: string | null;
  prompt: string | null;
  aspectRatio:
    | "1:1"
    | "2:3"
    | "3:2"
    | "3:4"
    | "4:3"
    | "9:16"
    | "16:9"
    | "21:9"
    | null;
  imageSize: "1K" | "2K" | "4K" | null;
}

interface BotActions {
  actions: BotAction[];
}

interface AutoReactResponse {
  emojis: string[];
}

export class ConversationFeature implements Feature {
  private ctx!: RuntimeContext;
  private botUserId?: string;
  private readonly contexts = new Map<string, ConversationState>();
  private responseDecision!: ResponseDecision;

  getContext(channelId: string): ConversationContext | undefined {
    const context = this.contexts.get(channelId);
    if (!context) {
      return undefined;
    }
    return {
      history: context.history,
      isDm: context.isDm,
    };
  }

  formatContext(context: ConversationContext): string {
    return this.responseDecision.buildConversationContext(context);
  }

  chatWithContext(
    channelId: string,
    options: {
      systemMessage: string;
      userMessage: string;
      allowSearch?: boolean;
    },
  ) {
    const context = this.getContext(channelId);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: options.systemMessage,
      },
    ];
    if (context && context.history.length > 0) {
      const contextText = this.formatContext(context);
      messages.push({
        role: "user",
        content: `Recent conversation context:\n${contextText}`,
      });
    }
    messages.push({
      role: "user",
      content: options.userMessage,
    });
    const chatOptions: { messages: ChatMessage[]; allowSearch?: boolean } = {
      messages,
    };
    if (options.allowSearch !== undefined) {
      chatOptions.allowSearch = options.allowSearch;
    }
    return this.ctx.openai.chat(chatOptions);
  }

  chatStructuredWithContext<T>(
    channelId: string,
    options: {
      systemMessage: string;
      userMessage: string;
      schema: { [key: string]: unknown };
      schemaName: string;
      schemaDescription?: string;
      allowSearch?: boolean;
      model?: string;
    },
  ) {
    const context = this.getContext(channelId);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: options.systemMessage,
      },
    ];
    if (context && context.history.length > 0) {
      const contextText = this.formatContext(context);
      messages.push({
        role: "user",
        content: `Recent conversation context:\n${contextText}`,
      });
    }
    messages.push({
      role: "user",
      content: options.userMessage,
    });
    const chatOptions: {
      messages: ChatMessage[];
      schema: { [key: string]: unknown };
      schemaName: string;
      schemaDescription?: string;
      allowSearch?: boolean;
      model?: string;
    } = {
      messages,
      schema: options.schema,
      schemaName: options.schemaName,
    };
    if (options.schemaDescription !== undefined) {
      chatOptions.schemaDescription = options.schemaDescription;
    }
    if (options.allowSearch !== undefined) {
      chatOptions.allowSearch = options.allowSearch;
    }
    if (options.model !== undefined) {
      chatOptions.model = options.model;
    }
    return this.ctx.openai.chatStructured<T>(chatOptions);
  }

  formatContextWithIds(context: ConversationContext): {
    text: string;
    references: MessageReference[];
  } {
    const now = Date.now();
    const lines: string[] = [];
    const references: MessageReference[] = [];

    for (const message of context.history) {
      const messageId = message.messageId || `msg_${message.timestamp}`;
      const timeAgo = Math.round((now - message.timestamp) / 1000);
      const timeAgoText =
        timeAgo < 60
          ? `${timeAgo}s ago`
          : timeAgo < 3600
            ? `${Math.round(timeAgo / 60)}m ago`
            : `${Math.round(timeAgo / 3600)}h ago`;

      const authorMatch = message.content.match(/^([^:]+): (.+)$/);
      const author = authorMatch ? authorMatch[1] : undefined;
      const content = authorMatch ? authorMatch[2] : message.content;

      lines.push(
        `[${timeAgoText}] [${messageId}] ${message.role}: ${message.content}`,
      );
      if (message.role !== "system") {
        const reference: MessageReference = {
          id: messageId,
          role: message.role,
          content: content || "",
        };
        if (author !== undefined) {
          reference.author = author;
        }
        references.push(reference);
      }
    }

    return {
      text: lines.join("\n"),
      references,
    };
  }

  getAllContexts(): Array<{ channelId: string; context: ConversationContext }> {
    const results: Array<{ channelId: string; context: ConversationContext }> =
      [];
    for (const [channelId, state] of this.contexts.entries()) {
      if (state.history.length > 0) {
        results.push({
          channelId,
          context: {
            history: state.history,
            isDm: state.isDm,
          },
        });
      }
    }
    return results;
  }

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.responseDecision = new ResponseDecision({
      openai: context.openai,
      logger: context.logger,
      conversation: this,
    });
    context.discord.once("ready", (client) => {
      this.botUserId = client.user.id;
      this.responseDecision = new ResponseDecision({
        openai: context.openai,
        botUserId: client.user.id,
        logger: context.logger,
        conversation: this,
      });
      void this.handleStartup();
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
    const historyEntry: {
      role: "user";
      content: string;
      timestamp: number;
      messageId: string;
      images?: string[];
    } = {
      role: "user",
      content: formatted,
      timestamp: message.createdTimestamp,
      messageId: message.id,
    };
    if (enriched.images.length > 0) {
      historyEntry.images = enriched.images;
    }
    context.history.push(historyEntry);
    context.history = context.history.slice(-12);
    this.contexts.set(key, context);

    const shouldRespond = await this.responseDecision.shouldRespond(
      message,
      context,
    );

    if (!shouldRespond) {
      if (Math.random() < AUTO_REACT_PROBABILITY) {
        await this.handleAutoReact(message, context);
      }
      return;
    }

    await (message.channel as { sendTyping: () => Promise<void> }).sendTyping();

    const contextWithIds = this.formatContextWithIds(context);
    const emojiList = this.buildEmojiList();
    const emojiContext =
      emojiList.length > 0
        ? `\n\nAvailable custom emoji (including your generated emojis): ${emojiList}\nYou can use either standard Unicode emoji or custom emoji names/format.`
        : "";

    const systemMessage = `${PERSONA}\nCurrent date: ${DateTime.now().toISO()}\nRespond in lowercase only.

You can perform multiple actions:
- send_message: Send a text message to the channel
- react: React to a message by referencing its message ID
- generate_image: Generate an image with a prompt

Message references in context:
${contextWithIds.references.map((ref) => `- ${ref.id}: ${ref.role}${ref.author ? ` (${ref.author})` : ""}: ${ref.content}`).join("\n")}${emojiContext}`;

    const response = await this.chatStructuredWithContext<BotActions>(
      message.channelId,
      {
        systemMessage,
        userMessage: `Recent conversation:\n${contextWithIds.text}\n\nWhat actions should you take?`,
        allowSearch: true,
        schema: {
          type: "object",
          properties: {
            actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["send_message", "react", "generate_image"],
                    description: "The type of action to perform",
                  },
                  content: {
                    type: ["string", "null"],
                    description:
                      "Message content (required for send_message, null otherwise)",
                  },
                  messageId: {
                    type: ["string", "null"],
                    description:
                      "Message ID to react to (required for react, null otherwise)",
                  },
                  emoji: {
                    type: ["string", "null"],
                    description:
                      "Emoji to react with. Can be Unicode emoji or custom emoji name/format. (required for react, null otherwise)",
                  },
                  prompt: {
                    type: ["string", "null"],
                    description:
                      "Image generation prompt (required for generate_image, null otherwise)",
                  },
                  aspectRatio: {
                    type: ["string", "null"],
                    enum: [
                      "1:1",
                      "2:3",
                      "3:2",
                      "3:4",
                      "4:3",
                      "9:16",
                      "16:9",
                      "21:9",
                    ],
                    description:
                      "Aspect ratio for image generation (optional, defaults to 1:1)",
                  },
                  imageSize: {
                    type: ["string", "null"],
                    enum: ["1K", "2K", "4K"],
                    description:
                      "Image size for image generation (optional, defaults to 1K)",
                  },
                },
                required: [
                  "type",
                  "content",
                  "messageId",
                  "emoji",
                  "prompt",
                  "aspectRatio",
                  "imageSize",
                ],
                additionalProperties: false,
              },
            },
          },
          required: ["actions"],
          additionalProperties: false,
        },
        schemaName: "botActions",
        schemaDescription: "List of actions for the bot to perform",
      },
    );

    await response.match(
      async (actions) => {
        this.ctx.logger.info({ actions }, "Action output");
        const messageIdMap = new Map<string, Message>();
        for (const ref of contextWithIds.references) {
          const matchingMessage = await this.findMessageById(
            message.channelId,
            ref.id,
          );
          if (matchingMessage) {
            messageIdMap.set(ref.id, matchingMessage);
          }
        }
        messageIdMap.set(message.id, message);

        for (const action of actions.actions) {
          if (action.type === "send_message" && action.content !== null) {
            const channel = await this.ctx.discord.channels.fetch(
              message.channelId,
            );
            if (channel && channel.isTextBased() && "send" in channel) {
              try {
                const sentMessage = await channel.send(action.content);
                context.history.push({
                  role: "assistant",
                  content: action.content,
                  timestamp: Date.now(),
                  messageId: sentMessage.id,
                });
              } catch (sendError) {
                this.ctx.logger.error(
                  { err: sendError },
                  "Failed to deliver message",
                );
              }
            }
          } else if (
            action.type === "react" &&
            action.messageId !== null &&
            action.emoji !== null
          ) {
            const targetMessage = messageIdMap.get(action.messageId) || message;
            const emoji = this.resolveEmoji(action.emoji);
            if (emoji) {
              try {
                await targetMessage.react(emoji);
              } catch (error) {
                this.ctx.logger.warn({ err: error, emoji }, "Failed to react");
              }
            }
          } else if (
            action.type === "generate_image" &&
            action.prompt !== null
          ) {
            const imageOptions: {
              prompt: string;
              aspectRatio?:
                | "1:1"
                | "2:3"
                | "3:2"
                | "3:4"
                | "4:3"
                | "9:16"
                | "16:9"
                | "21:9";
              imageSize?: "1K" | "2K" | "4K";
            } = {
              prompt: action.prompt,
            };
            if (action.aspectRatio !== null) {
              imageOptions.aspectRatio = action.aspectRatio;
            }
            if (action.imageSize !== null) {
              imageOptions.imageSize = action.imageSize;
            }
            const imageResult =
              await this.ctx.openai.generateImage(imageOptions);
            await imageResult.match(
              async ({ buffer }) => {
                await this.ctx.messenger
                  .sendBuffer(
                    message.channelId,
                    buffer,
                    "samebot-image.png",
                    action.prompt!,
                  )
                  .match(
                    async () => undefined,
                    async (sendError: BotError) => {
                      this.ctx.logger.error(
                        { err: sendError },
                        "Failed to send image",
                      );
                    },
                  );
              },
              async (error) => {
                this.ctx.logger.error(
                  { err: error },
                  "Image generation failed",
                );
              },
            );
          }
        }

        context.history = context.history.slice(-12);
        context.lastResponseAt = Date.now();
      },
      async (error) => {
        this.ctx.logger.error(
          { err: error },
          "Failed to generate chat response",
        );
        if (error.type === "openai") {
          await this.ctx.messenger
            .sendToChannel(message.channelId, "something broke, back in a bit")
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
        messageId: string;
        images?: string[];
      }> = [];

      for (const [messageId, msg] of messages) {
        if (msg.author.bot || msg.system) {
          if (msg.author.id === this.botUserId) {
            const content = msg.content || "(silent)";
            newMessages.push({
              role: "assistant",
              content,
              timestamp: msg.createdTimestamp,
              messageId: msg.id,
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
        const historyEntry: {
          role: "user";
          content: string;
          timestamp: number;
          messageId: string;
          images?: string[];
        } = {
          role: "user",
          content: formatted,
          timestamp: msg.createdTimestamp,
          messageId: msg.id,
        };
        if (enriched.images.length > 0) {
          historyEntry.images = enriched.images;
        }
        newMessages.push(historyEntry);
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

  buildEmojiList(): string {
    const emojiList: string[] = [];
    for (const emoji of this.ctx.customEmoji.values()) {
      const format = emoji.animated
        ? `<a:${emoji.name}:${emoji.id}>`
        : `<:${emoji.name}:${emoji.id}>`;
      emojiList.push(`${emoji.name} (${format})`);
    }
    return emojiList.join(", ");
  }

  private resolveEmoji(emojiString: string): string | null {
    const trimmed = emojiString.trim();

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

    const customEmoji = this.ctx.customEmoji.get(trimmed);
    if (customEmoji) {
      return customEmoji.animated
        ? `<a:${customEmoji.name}:${customEmoji.id}>`
        : `<:${customEmoji.name}:${customEmoji.id}>`;
    }

    return trimmed;
  }

  private async findMessageById(
    channelId: string,
    messageId: string,
  ): Promise<Message | null> {
    try {
      const channel =
        this.ctx.discord.channels.cache.get(channelId) ||
        (await this.ctx.discord.channels.fetch(channelId));
      if (!channel || !channel.isTextBased()) {
        return null;
      }
      const msg = await channel.messages.fetch(messageId);
      return msg;
    } catch (error) {
      this.ctx.logger.warn(
        { err: error, channelId, messageId },
        "Failed to find message by ID",
      );
    }
    return null;
  }

  private async handleStartup() {
    const mainChannelId = this.ctx.config.mainChannelId;
    const channel =
      this.ctx.discord.channels.cache.get(mainChannelId) ||
      (await this.ctx.discord.channels.fetch(mainChannelId));

    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      return;
    }

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    try {
      const messages = await channel.messages.fetch({ limit: 10 });
      if (messages.size === 0) {
        return;
      }

      const mostRecentMessage = Array.from(messages.values())[0];
      if (
        !mostRecentMessage ||
        mostRecentMessage.createdTimestamp < oneDayAgo
      ) {
        return;
      }

      const key = channel.id;
      let context = this.contexts.get(key) ?? {
        history: [],
        isDm: false,
      };

      const newMessages: Array<{
        role: "user" | "assistant";
        content: string;
        timestamp: number;
        messageId: string;
      }> = [];

      for (const msg of messages.values()) {
        if (msg.author.bot || msg.system) {
          if (msg.author.id === this.botUserId) {
            newMessages.push({
              role: "assistant",
              content: msg.content || "(silent)",
              timestamp: msg.createdTimestamp,
              messageId: msg.id,
            });
          }
          continue;
        }

        const enriched = await this.enrichContent(msg);
        const formatted = `${
          msg.author.displayName || msg.author.username
        }: ${enriched.content}`;
        newMessages.push({
          role: "user",
          content: formatted,
          timestamp: msg.createdTimestamp,
          messageId: msg.id,
        });
      }

      if (newMessages.length > 0) {
        context.history.push(...newMessages);
        context.history.sort((a, b) => a.timestamp - b.timestamp);
        context.history = context.history.slice(-6);
        this.contexts.set(key, context);

        const startupMessage = await this.chatWithContext(channel.id, {
          systemMessage: `${PERSONA}\nCurrent date: ${DateTime.now().toISO()}\nRespond in lowercase only.`,
          userMessage:
            "Generate a brief startup message announcing that samebot has restarted successfully. Keep it short and contextually relevant to the conversation.",
        });

        await startupMessage.match(
          async (message) => {
            await this.ctx.messenger.sendToChannel(channel.id, message).match(
              async () => undefined,
              async (error) => {
                this.ctx.logger.warn(
                  { err: error, channelId: channel.id },
                  "Failed to send startup message",
                );
              },
            );
          },
          async (error) => {
            this.ctx.logger.warn(
              { err: error, channelId: channel.id },
              "Failed to generate startup message",
            );
          },
        );
      }
    } catch (error) {
      this.ctx.logger.warn(
        { err: error, channelId: channel.id },
        "Failed to process channel for startup message",
      );
    }
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

  private async handleAutoReact(message: Message, context: ConversationState) {
    const emojiList = this.buildEmojiList();
    const contextText = this.formatContext(context);

    const systemMessage = `${PERSONA}
You are deciding whether to react to a message with emoji(s).

Available custom emoji (including your generated emojis): ${emojiList || "none"}
You can also use any standard Unicode emoji.

Based on the conversation context and the most recent message, decide if any emoji reactions would be appropriate and fun.
Return 0 to 3 emojis that would make good reactions. Return an empty array if no reaction feels right.
For custom emoji, use just the name (e.g. "happy_cat"). For Unicode emoji, use the emoji directly (e.g. "😂").`;

    const response = await this.ctx.openai.chatStructured<AutoReactResponse>({
      messages: [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: `Conversation context:\n${contextText}\n\nMost recent message to potentially react to:\n${message.content}`,
        },
      ],
      schema: {
        type: "object",
        properties: {
          emojis: {
            type: "array",
            items: {
              type: "string",
              description: "Emoji name (for custom) or Unicode emoji character",
            },
            description: "Array of 0-3 emojis to react with",
          },
        },
        required: ["emojis"],
        additionalProperties: false,
      },
      schemaName: "autoReact",
      schemaDescription: "Emoji reactions to add to message",
    });

    await response.match(
      async (result) => {
        if (result.emojis.length === 0) {
          return;
        }

        this.ctx.logger.info(
          { emojis: result.emojis, messageId: message.id },
          "Auto-reacting to message",
        );

        for (const emojiInput of result.emojis.slice(0, 3)) {
          const emoji = this.resolveEmoji(emojiInput);
          if (emoji) {
            try {
              await message.react(emoji);
            } catch (error) {
              this.ctx.logger.warn(
                { err: error, emoji: emojiInput },
                "Failed to auto-react",
              );
            }
          }
        }
      },
      async (error) => {
        this.ctx.logger.warn({ err: error }, "Failed to generate auto-react");
      },
    );
  }
}
