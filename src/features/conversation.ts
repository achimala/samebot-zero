import type { Message, ChatInputCommandInteraction } from "discord.js";
import { DateTime } from "luxon";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { Agent } from "../agent/agent";
import { ResponseDecision } from "../agent/response-decision";
import type {
  AgentContext,
  AgentMessage,
  IncomingMessage,
} from "../agent/types";
import { DiscordAdapter } from "../adapters/discord";
import { EntityResolver } from "../utils/entity-resolver";

const AUTO_REACT_PROBABILITY = 0.15;
const MEMORY_EXTRACTION_INTERVAL = 6;

interface ConversationState {
  history: AgentMessage[];
  isDm: boolean;
  channelId: string;
  lastScrapbookMemoryId?: string;
  lastResponseAt?: number;
  messagesSinceLastExtraction: number;
  lastExtractedTimestamp: number;
}

export class ConversationFeature implements Feature {
  private ctx!: RuntimeContext;
  private botUserId?: string;
  private readonly contexts = new Map<string, ConversationState>();
  private agent!: Agent;
  private adapter!: DiscordAdapter;
  private responseDecision!: ResponseDecision;
  private entityResolver!: EntityResolver;

  getContext(channelId: string): AgentContext | undefined {
    const context = this.contexts.get(channelId);
    if (!context) {
      return undefined;
    }
    const agentContext: AgentContext = {
      history: context.history,
      isDm: context.isDm,
      channelId: context.channelId,
    };
    if (context.lastScrapbookMemoryId !== undefined) {
      agentContext.lastScrapbookMemoryId = context.lastScrapbookMemoryId;
    }
    return agentContext;
  }

  formatContext(context: AgentContext): string {
    return this.agent.formatContextText(context);
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
    if (!context) {
      const chatOptions: {
        messages: Array<{
          role: "system" | "user" | "assistant";
          content: string;
        }>;
        allowSearch?: boolean;
      } = {
        messages: [
          { role: "system", content: options.systemMessage },
          { role: "user", content: options.userMessage },
        ],
      };
      if (options.allowSearch !== undefined) {
        chatOptions.allowSearch = options.allowSearch;
      }
      return this.ctx.openai.chat(chatOptions);
    }
    return this.agent.chatWithContext(context, options);
  }

  getAllContexts(): Array<{ channelId: string; context: AgentContext }> {
    const results: Array<{ channelId: string; context: AgentContext }> = [];
    for (const [channelId, state] of this.contexts.entries()) {
      if (state.history.length > 0) {
        const agentContext: AgentContext = {
          history: state.history,
          isDm: state.isDm,
          channelId: state.channelId,
        };
        if (state.lastScrapbookMemoryId !== undefined) {
          agentContext.lastScrapbookMemoryId = state.lastScrapbookMemoryId;
        }
        results.push({
          channelId,
          context: agentContext,
        });
      }
    }
    return results;
  }

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.entityResolver = new EntityResolver(context.supabase, context.logger);

    this.adapter = new DiscordAdapter(
      context.discord,
      context.messenger,
      context.customEmoji,
      context.logger,
    );

    this.agent = new Agent(
      context.openai,
      context.memory,
      context.scrapbook,
      this.entityResolver,
      context.supabase,
      context.logger,
      context.customEmoji,
      this.adapter,
    );

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
      if (!interaction.isChatInputCommand()) {
        return;
      }
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
      channelId: key,
      messagesSinceLastExtraction: 0,
      lastExtractedTimestamp: 0,
    };
    context.isDm = isDm;

    await this.backfillMessages(message.channelId, context, message.id);

    const existingMessageIds = new Set(context.history.map((msg) => msg.id));
    if (existingMessageIds.has(message.id)) {
      context.history = context.history.slice(-12);
      this.contexts.set(key, context);
      return;
    }

    const incomingMessage = await this.adapter.toIncomingMessage(
      message,
      this.botUserId,
    );
    const agentMessage = this.toAgentMessage(incomingMessage);
    context.history.push(agentMessage);
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
          const batchContext = newMessages
            .map((m) => (m.author ? `${m.author}: ${m.content}` : m.content))
            .join("\n");
          context.lastExtractedTimestamp = Date.now();
          context.messagesSinceLastExtraction = 0;
          this.contexts.set(key, context);

          void this.ctx.memory.extractFromBatch(batchContext).catch((error) => {
            this.ctx.logger.error({ err: error }, "Failed to extract memories");
          });
        }
      }
    }

    const agentContext = this.toAgentContext(context);
    const shouldRespond = await this.responseDecision.shouldRespond(
      incomingMessage,
      agentContext,
    );

    if (!shouldRespond) {
      if (Math.random() < AUTO_REACT_PROBABILITY) {
        await this.handleAutoReact(message, agentContext);
      }
      return;
    }

    await this.adapter.sendTyping(message.channelId);

    const response = await this.agent.generateResponse(
      agentContext,
      message.id,
    );

    if (response.text && response.text.length > 0) {
      const sendResult = await this.adapter.sendMessage(
        message.channelId,
        response.text,
      );
      if (sendResult.messageId) {
        context.history.push({
          id: sendResult.messageId,
          role: "assistant",
          content: response.text,
          timestamp: Date.now(),
        });
      }
    }

    context.history = context.history.slice(-12);
    context.lastResponseAt = Date.now();
    this.contexts.set(key, context);
  }

  private async backfillMessages(
    channelId: string,
    context: ConversationState,
    beforeMessageId: string,
  ) {
    try {
      const messages = await this.adapter.fetchRecentMessages(
        channelId,
        50,
        beforeMessageId,
      );

      const existingMessageIds = new Set(context.history.map((msg) => msg.id));

      const newMessages: AgentMessage[] = [];

      for (const msg of messages) {
        if (existingMessageIds.has(msg.id)) {
          continue;
        }

        if (msg.author.bot || msg.system) {
          if (msg.author.id === this.botUserId) {
            const content = msg.content || "(silent)";
            newMessages.push({
              id: msg.id,
              role: "assistant",
              content,
              timestamp: msg.createdTimestamp,
            });
          }
          continue;
        }

        const incomingMessage = await this.adapter.toIncomingMessage(
          msg,
          this.botUserId,
        );
        newMessages.push(this.toAgentMessage(incomingMessage));
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

  private toAgentMessage(incoming: IncomingMessage): AgentMessage {
    const message: AgentMessage = {
      id: incoming.id,
      role: "user",
      content: incoming.content,
      author: incoming.authorName,
      timestamp: incoming.timestamp,
    };
    if (incoming.images.length > 0) {
      message.images = incoming.images;
    }
    return message;
  }

  private toAgentContext(state: ConversationState): AgentContext {
    const agentContext: AgentContext = {
      history: state.history,
      isDm: state.isDm,
      channelId: state.channelId,
    };
    if (state.lastScrapbookMemoryId !== undefined) {
      agentContext.lastScrapbookMemoryId = state.lastScrapbookMemoryId;
    }
    return agentContext;
  }

  private async handleStartup() {
    const mainChannelId = this.ctx.config.mainChannelId;

    try {
      const messages = await this.adapter.fetchRecentMessages(
        mainChannelId,
        10,
      );

      if (messages.length === 0) {
        return;
      }

      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const mostRecentMessage = messages[0];
      if (
        !mostRecentMessage ||
        mostRecentMessage.createdTimestamp < oneDayAgo
      ) {
        return;
      }

      const key = mainChannelId;
      let context = this.contexts.get(key) ?? {
        history: [],
        isDm: false,
        channelId: mainChannelId,
        messagesSinceLastExtraction: 0,
        lastExtractedTimestamp: 0,
      };

      const existingMessageIds = new Set(context.history.map((msg) => msg.id));

      const newMessages: AgentMessage[] = [];

      for (const msg of messages) {
        if (existingMessageIds.has(msg.id)) {
          continue;
        }

        if (msg.author.bot || msg.system) {
          if (msg.author.id === this.botUserId) {
            newMessages.push({
              id: msg.id,
              role: "assistant",
              content: msg.content || "(silent)",
              timestamp: msg.createdTimestamp,
            });
          }
          continue;
        }

        const incomingMessage = await this.adapter.toIncomingMessage(
          msg,
          this.botUserId,
        );
        newMessages.push(this.toAgentMessage(incomingMessage));
      }

      if (newMessages.length > 0) {
        context.history.push(...newMessages);
        context.history.sort((a, b) => a.timestamp - b.timestamp);
        context.history = context.history.slice(-6);
        this.contexts.set(key, context);

        const agentContext = this.toAgentContext(context);
        const startupResponse = await this.agent.chatWithContext(agentContext, {
          systemMessage: `you are samebot, a hyper-intelligent, lowercase-talking friend with a dry, sarcastic British tone.\nCurrent date: ${DateTime.now().toISO()}\nRespond in lowercase only.`,
          userMessage:
            "Generate a brief startup message announcing that samebot has restarted successfully. Keep it short and contextually relevant to the conversation.",
        });

        startupResponse.match(
          (responseText) => {
            void this.adapter.sendMessage(mainChannelId, responseText);
          },
          (error) => {
            this.ctx.logger.warn(
              { err: error },
              "Failed to generate startup message",
            );
          },
        );
      }
    } catch (error) {
      this.ctx.logger.warn(
        { err: error, channelId: mainChannelId },
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

    const agentContext = this.toAgentContext(context);
    const contextWithIds = this.agent.formatContextWithIds(agentContext);
    const emojiList = this.agent.buildEmojiList();

    const payload = `=== CONTEXT (${context.history.length} messages) ===\n${contextWithIds.text}\n\n=== EMOJI ===\n${emojiList || "(none)"}`;

    await interaction.reply({
      content: `\`\`\`\n${payload.slice(-1900)}\n\`\`\``,
      ephemeral: true,
    });
  }

  private async handleAutoReact(message: Message, context: AgentContext) {
    const emojis = await this.agent.generateAutoReact(
      context,
      message.content || "(silent)",
    );

    if (emojis.length === 0) {
      return;
    }

    this.ctx.logger.info(
      { emojis, messageId: message.id },
      "Auto-reacting to message",
    );

    for (const emojiInput of emojis) {
      const emoji = this.adapter.resolveEmoji(emojiInput);
      if (emoji) {
        await this.adapter.react(message.channelId, message.id, emoji);
      }
    }
  }
}
