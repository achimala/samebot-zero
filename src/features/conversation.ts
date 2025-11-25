import type {
  Message,
  ChatInputCommandInteraction,
  GuildChannel,
} from "discord.js";
import { DateTime } from "luxon";
import { type Feature, type RuntimeContext } from "../core/runtime";
import type {
  ChatMessage,
  ToolMessage,
  ToolDefinition,
  ToolCall,
} from "../openai/client";
import type { BotError } from "../core/errors";
import {
  ResponseDecision,
  type ConversationContext,
} from "../utils/response-decision";
import { EntityResolver } from "../utils/entity-resolver";

const AUTO_REACT_PROBABILITY = 0.15;

const PERSONA = `you are samebot, a hyper-intelligent, lowercase-talking friend with a dry, sarcastic British tone.
you're quintessentially British - use British spellings (colour, realise, organise, etc.), British expressions ("brilliant", "cheers", "bloody hell", "right", "proper", "bit", "quite", "rather"), and British humour (dry wit, understatement, self-deprecation).
you keep responses extremely short, rarely use emojis, and occasionally swear for comedic effect (British swearing like "bloody", "bugger", "sodding").
always respond very briefly - aim for 5-10 words maximum. be terse and to the point. only expand if explicitly asked for detail.
speak like a proper Brit - understated, witty, and occasionally self-deprecating.`;

const MEMORY_EXTRACTION_INTERVAL = 6;
const MAX_TOOL_ITERATIONS = 10;

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "react",
    description:
      "React to a message with an emoji. Use this to add emoji reactions to messages in the conversation.",
    parameters: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The ID of the message to react to",
        },
        emoji: {
          type: "string",
          description:
            "The emoji to react with. Can be a Unicode emoji or a custom emoji name.",
        },
      },
      required: ["messageId", "emoji"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_image",
    description:
      "Generate an image based on a text prompt. Use this when asked to create, draw, or generate images.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "A detailed description of the image to generate",
        },
        aspectRatio: {
          type: ["string", "null"],
          enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
          description: "The aspect ratio for the image (defaults to 1:1)",
        },
        imageSize: {
          type: ["string", "null"],
          enum: ["1K", "2K", "4K"],
          description: "The resolution of the image (defaults to 1K)",
        },
      },
      required: ["prompt", "aspectRatio", "imageSize"],
      additionalProperties: false,
    },
  },
  {
    name: "search_memory",
    description:
      "Search your memory for information about someone or something. Use this when asked about things you should know but don't have in current context.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find relevant memories",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_scrapbook_memory",
    description:
      "Get a random memorable quote from the scrapbook. Use this when someone asks for a memory, story, or something from the scrapbook.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "search_scrapbook",
    description:
      "Search the scrapbook for memorable quotes matching a query. Use this when someone asks 'remember when...' or wants to find a specific old quote.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find matching scrapbook memories",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_scrapbook_context",
    description:
      "Get the surrounding conversation context for a scrapbook memory. Use this when someone asks for context, says 'what?', 'huh?', or reacts with confusion to a scrapbook quote.",
    parameters: {
      type: "object",
      properties: {
        memoryId: {
          type: "string",
          description: "The ID of the scrapbook memory to get context for",
        },
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_scrapbook_memory",
    description:
      "Delete a scrapbook memory. Use this when someone says 'bad memory' or asks to remove/forget a scrapbook quote.",
    parameters: {
      type: "object",
      properties: {
        memoryId: {
          type: "string",
          description: "The ID of the scrapbook memory to delete",
        },
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
  },
];

interface ConversationState extends ConversationContext {
  lastResponseAt?: number;
  messagesSinceLastExtraction: number;
  lastExtractedTimestamp: number;
  lastScrapbookMemoryId?: string;
}

interface MessageReference {
  id: string;
  role: "user" | "assistant";
  content: string;
  author?: string;
}

interface ToolExecutionContext {
  message: Message;
  channelId: string;
  messageIdMap: Map<string, Message>;
}

interface AutoReactResponse {
  emojis: string[];
}

export class ConversationFeature implements Feature {
  private ctx!: RuntimeContext;
  private botUserId?: string;
  private readonly contexts = new Map<string, ConversationState>();
  private responseDecision!: ResponseDecision;
  private entityResolver!: EntityResolver;

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
    const contextWithIds = this.formatContextWithIds(context);
    return contextWithIds.text;
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
    this.entityResolver = new EntityResolver(context.supabase, context.logger);
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
      messagesSinceLastExtraction: 0,
      lastExtractedTimestamp: 0,
    };
    context.isDm = isDm;

    await this.backfillMessages(message.channelId, context, message.id);

    const existingMessageIds = new Set(
      context.history.map((msg) => msg.messageId),
    );
    if (existingMessageIds.has(message.id)) {
      context.history = context.history.slice(-12);
      this.contexts.set(key, context);
      return;
    }

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

    const isMainChannel = message.channelId === this.ctx.config.mainChannelId;
    if (isMainChannel) {
      context.messagesSinceLastExtraction++;
      if (context.messagesSinceLastExtraction >= MEMORY_EXTRACTION_INTERVAL) {
        const newMessages = context.history.filter(
          (m) =>
            m.timestamp > context.lastExtractedTimestamp && m.role === "user",
        );
        if (newMessages.length > 0) {
          const batchContext = newMessages.map((m) => m.content).join("\n");
          context.lastExtractedTimestamp = Date.now();
          context.messagesSinceLastExtraction = 0;
          this.contexts.set(key, context);

          void this.ctx.memory.extractFromBatch(batchContext).catch((error) => {
            this.ctx.logger.error({ err: error }, "Failed to extract memories");
          });
        }
      }
    }

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

    const modelContext = await this.buildModelContext(
      context,
      message.channelId,
    );

    const messageIdMap = new Map<string, Message>();
    for (const ref of modelContext.contextWithIds.references) {
      const matchingMessage = await this.findMessageById(
        message.channelId,
        ref.id,
      );
      if (matchingMessage) {
        messageIdMap.set(ref.id, matchingMessage);
      }
    }
    messageIdMap.set(message.id, message);

    const executionContext: ToolExecutionContext = {
      message,
      channelId: message.channelId,
      messageIdMap,
    };

    const messages: Array<ChatMessage | ToolMessage> = [
      {
        role: "system",
        content: modelContext.systemMessage,
      },
      {
        role: "user",
        content: modelContext.userMessage,
      },
    ];

    let finalResponse: string | null = null;
    let previousResponseId: string | undefined;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const toolStepOptions: {
        messages: Array<ChatMessage | ToolMessage>;
        tools: ToolDefinition[];
        allowSearch: boolean;
        previousResponseId?: string;
      } = {
        messages,
        tools: TOOL_DEFINITIONS,
        allowSearch: true,
      };
      if (previousResponseId) {
        toolStepOptions.previousResponseId = previousResponseId;
      }
      const result = await this.ctx.openai.chatWithToolsStep(toolStepOptions);

      const stepResult = result.match(
        (value) => value,
        (error) => {
          this.ctx.logger.error(
            { err: error },
            "Failed to get tool step response",
          );
          return null;
        },
      );

      if (!stepResult) {
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
        return;
      }

      if (stepResult.done) {
        finalResponse = stepResult.text;
        break;
      }

      previousResponseId = stepResult.responseId;

      this.ctx.logger.info(
        { toolCalls: stepResult.toolCalls, iteration },
        "Executing tool calls",
      );

      for (const toolCall of stepResult.toolCalls) {
        const toolResult = await this.executeToolCall(
          toolCall,
          executionContext,
        );
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: toolResult,
        });
      }
    }

    if (finalResponse && finalResponse.length > 0) {
      const channel = await this.ctx.discord.channels.fetch(message.channelId);
      if (channel && channel.isTextBased() && "send" in channel) {
        try {
          const sentMessage = await channel.send(finalResponse);
          context.history.push({
            role: "assistant",
            content: finalResponse,
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
    }

    context.history = context.history.slice(-12);
    context.lastResponseAt = Date.now();
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
        context.history.map((msg) => msg.messageId),
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
        if (existingMessageIds.has(msg.id)) {
          continue;
        }

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
        messagesSinceLastExtraction: 0,
        lastExtractedTimestamp: 0,
      };

      const existingMessageIds = new Set(
        context.history.map((msg) => msg.messageId),
      );

      const newMessages: Array<{
        role: "user" | "assistant";
        content: string;
        timestamp: number;
        messageId: string;
      }> = [];

      for (const msg of messages.values()) {
        if (existingMessageIds.has(msg.id)) {
          continue;
        }

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

  private async buildModelContext(
    context: ConversationState,
    channelId: string,
  ): Promise<{
    systemMessage: string;
    userMessage: string;
    contextWithIds: { text: string; references: MessageReference[] };
  }> {
    const contextWithIds = this.formatContextWithIds(context);
    const emojiList = this.buildEmojiList();
    const emojiContext =
      emojiList.length > 0
        ? `\n\nAvailable custom emoji (including your generated emojis): ${emojiList}\nYou can use either standard Unicode emoji or custom emoji names/format.`
        : "";

    const availableEntities = await this.ctx.supabase.listEntityFolders();
    const entityContext =
      availableEntities.length > 0
        ? `\n\nWhen generating images, you can feature these people/entities (we have reference images for them): ${availableEntities.join(", ")}. Include them by name in your image prompt to use their likeness.`
        : "";

    const relevantMemories = await this.ctx.memory.getRelevantMemories(
      contextWithIds.text,
      10,
    );
    const memoryContext =
      relevantMemories.length > 0
        ? `\n\nThings you remember about the people in this conversation:\n${relevantMemories.map((m) => `- ${m.content}`).join("\n")}`
        : "";

    const scrapbookContext = context.lastScrapbookMemoryId
      ? `\n\nLast mentioned scrapbook memory ID: ${context.lastScrapbookMemoryId} (use this for get_scrapbook_context or delete_scrapbook_memory if someone asks for context or says "bad memory")`
      : "";

    const systemMessage = `${PERSONA}\nCurrent date: ${DateTime.now().toISO()}\nRespond in lowercase only.

You have tools available to:
- react: React to a message with an emoji
- generate_image: Generate an image with a prompt
- search_memory: Search your memory for information you don't currently recall
- get_scrapbook_memory: Get a random memorable quote from the scrapbook
- search_scrapbook: Search for specific memorable quotes
- get_scrapbook_context: Get the surrounding conversation for a scrapbook memory
- delete_scrapbook_memory: Delete a scrapbook memory (use when someone says "bad memory")

Your final text response will be sent as a message to the channel. Use tools for side effects (reactions, images, memory searches) and then provide your text response.

Message references in context (use these IDs when reacting):
${contextWithIds.references.map((ref) => `- ${ref.id}: ${ref.role}${ref.author ? ` (${ref.author})` : ""}: ${ref.content}`).join("\n")}${emojiContext}${entityContext}${memoryContext}${scrapbookContext}`;

    const userMessage = `Recent conversation:\n${contextWithIds.text}`;

    return {
      systemMessage,
      userMessage,
      contextWithIds,
    };
  }

  private async handleDebug(interaction: ChatInputCommandInteraction) {
    const key = interaction.channelId || interaction.user.id;
    const context = this.contexts.get(key);
    if (!context) {
      await interaction.reply({ content: "no context yet", ephemeral: true });
      return;
    }

    const modelContext = await this.buildModelContext(
      context,
      interaction.channelId || interaction.user.id,
    );

    const payload = `=== SYSTEM MESSAGE ===\n${modelContext.systemMessage}\n\n=== USER MESSAGE ===\n${modelContext.userMessage}`;

    await interaction.reply({
      content: `\`\`\`\n${payload.slice(-1900)}\n\`\`\``,
      ephemeral: true,
    });
  }

  private async executeToolCall(
    toolCall: ToolCall,
    executionContext: ToolExecutionContext,
  ): Promise<string> {
    const { message, channelId, messageIdMap } = executionContext;

    switch (toolCall.name) {
      case "react": {
        const messageId = toolCall.arguments.messageId as string;
        const emojiInput = toolCall.arguments.emoji as string;
        const targetMessage = messageIdMap.get(messageId) || message;
        const emoji = this.resolveEmoji(emojiInput);
        if (emoji) {
          try {
            await targetMessage.react(emoji);
            return `Successfully reacted with ${emojiInput}`;
          } catch (error) {
            this.ctx.logger.warn({ err: error, emoji }, "Failed to react");
            return `Failed to react with ${emojiInput}`;
          }
        }
        return `Could not resolve emoji: ${emojiInput}`;
      }

      case "generate_image": {
        const prompt = toolCall.arguments.prompt as string;
        const aspectRatio = toolCall.arguments.aspectRatio as
          | "1:1"
          | "2:3"
          | "3:2"
          | "3:4"
          | "4:3"
          | "9:16"
          | "16:9"
          | "21:9"
          | undefined;
        const imageSize = toolCall.arguments.imageSize as
          | "1K"
          | "2K"
          | "4K"
          | undefined;

        let effectivePrompt = prompt;
        let referenceImages:
          | Array<{ data: string; mimeType: string }>
          | undefined;

        const resolution = await this.entityResolver.resolve(prompt);
        if (resolution) {
          const built =
            this.entityResolver.buildPromptWithReferences(resolution);
          effectivePrompt = built.textPrompt;
          referenceImages = built.referenceImages;
        }

        const imageOptions: {
          prompt: string;
          referenceImages?: Array<{ data: string; mimeType: string }>;
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
          prompt: effectivePrompt,
        };
        if (referenceImages) {
          imageOptions.referenceImages = referenceImages;
        }
        if (aspectRatio) {
          imageOptions.aspectRatio = aspectRatio;
        }
        if (imageSize) {
          imageOptions.imageSize = imageSize;
        }

        const imageResult = await this.ctx.openai.generateImage(imageOptions);
        let resultMessage = "";
        await imageResult.match(
          async ({ buffer }) => {
            await this.ctx.messenger
              .sendBuffer(channelId, buffer, "samebot-image.png", prompt)
              .match(
                async () => {
                  resultMessage = `Successfully generated and sent image for: ${prompt}`;
                },
                async (sendError: BotError) => {
                  this.ctx.logger.error(
                    { err: sendError },
                    "Failed to send image",
                  );
                  resultMessage = `Generated image but failed to send it`;
                },
              );
          },
          async (error) => {
            this.ctx.logger.error({ err: error }, "Image generation failed");
            resultMessage = `Failed to generate image: ${error.message}`;
          },
        );
        return resultMessage;
      }

      case "search_memory": {
        const query = toolCall.arguments.query as string;
        const searchResults = await this.ctx.memory.searchMemories(query, 10);
        if (searchResults.length > 0) {
          const memoryResultsText = searchResults
            .map((m) => `- ${m.content}`)
            .join("\n");
          return `Found memories:\n${memoryResultsText}`;
        }
        return "No relevant memories found for that query.";
      }

      case "get_scrapbook_memory": {
        const memory = await this.ctx.scrapbook.getRandomMemory();
        if (memory) {
          const key = channelId;
          const context = this.contexts.get(key);
          if (context) {
            context.lastScrapbookMemoryId = memory.id;
          }
          return `Found scrapbook memory [${memory.id}]: "${memory.keyMessage}" - ${memory.author}`;
        }
        return "No scrapbook memories found.";
      }

      case "search_scrapbook": {
        const query = toolCall.arguments.query as string;
        const results = await this.ctx.scrapbook.searchMemories(query, 5);
        if (results.length > 0) {
          const key = channelId;
          const context = this.contexts.get(key);
          const firstResult = results[0];
          if (context && firstResult) {
            context.lastScrapbookMemoryId = firstResult.id;
          }
          const resultsText = results
            .map((m) => `[${m.id}]: "${m.keyMessage}" - ${m.author}`)
            .join("\n");
          return `Found scrapbook memories:\n${resultsText}`;
        }
        return "No matching scrapbook memories found.";
      }

      case "get_scrapbook_context": {
        const memoryId = toolCall.arguments.memoryId as string;
        const memory = await this.ctx.scrapbook.getMemoryById(memoryId);
        if (memory) {
          const contextText = this.ctx.scrapbook.formatContext(memory);
          return `Context for "${memory.keyMessage}":\n${contextText}`;
        }
        return "Could not find that scrapbook memory.";
      }

      case "delete_scrapbook_memory": {
        const memoryId = toolCall.arguments.memoryId as string;
        const success = await this.ctx.scrapbook.deleteMemory(memoryId);
        if (success) {
          return "Deleted the scrapbook memory.";
        }
        return "Could not delete that scrapbook memory.";
      }

      default:
        return `Unknown tool: ${toolCall.name}`;
    }
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
