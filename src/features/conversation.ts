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
import {
  shouldConvertToAphorism,
  convertToAphorism,
} from "../utils/aphorism-converter";
import type { ModelTier } from "../llm/claude";

const AUTO_REACT_PROBABILITY = 0.15;
const SAY_SAME_PROBABILITY = 0.2;
const HISTORY_LIMIT = 50;

interface ConversationState {
  history: AgentMessage[];
  isDm: boolean;
  channelId: string;
  lastResponseAt?: number;
  /** Whether history has been backfilled from Discord since startup. */
  initialized: boolean;
}

export class ConversationFeature implements Feature {
  private ctx!: RuntimeContext;
  private botUserId?: string;
  private readonly contexts = new Map<string, ConversationState>();
  private agent!: Agent;
  private adapter!: DiscordAdapter;
  private responseDecision!: ResponseDecision;
  private entityResolver!: EntityResolver;
  /** Per-channel promise chains so messages in a channel are handled in order. */
  private readonly channelQueues = new Map<string, Promise<void>>();

  getContext(channelId: string): AgentContext | undefined {
    const context = this.contexts.get(channelId);
    if (!context) {
      return undefined;
    }
    return {
      history: context.history,
      isDm: context.isDm,
      channelId: context.channelId,
    };
  }

  formatContext(context: AgentContext): string {
    return this.agent.formatContextText(context);
  }

  chatWithContext(
    channelId: string,
    options: {
      systemMessage: string;
      userMessage: string;
      webSearch?: boolean;
      preserveWhitespace?: boolean;
      model?: ModelTier;
    },
  ) {
    const context = this.getContext(channelId) ?? {
      history: [],
      isDm: false,
      channelId,
    };
    return this.agent.chatWithContext(context, options);
  }

  getAllContexts(): Array<{ channelId: string; context: AgentContext }> {
    const results: Array<{ channelId: string; context: AgentContext }> = [];
    for (const [channelId, state] of this.contexts.entries()) {
      if (state.history.length > 0) {
        results.push({
          channelId,
          context: {
            history: state.history,
            isDm: state.isDm,
            channelId: state.channelId,
          },
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
      context.llm,
      context.gemini,
      context.memory,
      context.scrapbook,
      this.entityResolver,
      context.supabase,
      context.logger,
      context.customEmoji,
      this.adapter,
    );

    this.responseDecision = new ResponseDecision({
      decisions: context.decisions,
      logger: context.logger,
    });

    context.discord.once("clientReady", (client) => {
      this.botUserId = client.user.id;
      this.responseDecision = new ResponseDecision({
        decisions: context.decisions,
        botUserId: client.user.id,
        logger: context.logger,
      });
      void this.handleStartup();
    });

    context.discord.on("messageCreate", (message) => {
      this.enqueue(message.channelId || message.author.id, () =>
        this.handleMessage(message),
      );
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

  private enqueue(key: string, task: () => Promise<void>) {
    const previous = this.channelQueues.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error: unknown) => {
        this.ctx.logger.error({ err: error, channelId: key }, "Failed to handle message");
      })
      .finally(() => {
        if (this.channelQueues.get(key) === next) {
          this.channelQueues.delete(key);
        }
      });
    this.channelQueues.set(key, next);
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
      channelId: key,
      initialized: false,
    };
    context.isDm = isDm;
    this.contexts.set(key, context);

    if (!context.initialized) {
      await this.backfillMessages(message.channelId, context, message.id);
      context.initialized = true;
    }

    if (context.history.some((msg) => msg.id === message.id)) {
      return;
    }

    const incomingMessage = await this.adapter.toIncomingMessage(
      message,
      this.botUserId,
    );

    let userMessageContent = incomingMessage.content || "";
    let aphorismReply: string | null = null;

    if (userMessageContent.length > 0) {
      const shouldConvert = await shouldConvertToAphorism(
        userMessageContent,
        this.ctx.decisions,
        this.ctx.logger,
      );

      if (shouldConvert) {
        const converted = await convertToAphorism(
          userMessageContent,
          this.ctx.llm,
          this.ctx.logger,
        );
        if (converted) {
          userMessageContent = converted;
          aphorismReply = converted;
        }
      }
    }

    const agentMessage = this.toAgentMessage({
      ...incomingMessage,
      content: userMessageContent,
    });
    this.appendHistory(context, agentMessage);

    if (aphorismReply) {
      await this.sendReply(message.channelId, context, aphorismReply);
      return;
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

    const latestContent = incomingMessage.content || "(silent)";
    const replyBriefly =
      Math.random() < SAY_SAME_PROBABILITY &&
      (await this.responseDecision.shouldReplyBriefly(
        agentContext,
        latestContent,
      ));
    const response = replyBriefly
      ? await this.agent.generateBriefReply(agentContext)
      : await this.agent.generateResponse(agentContext, message.id);

    if (response.text && response.text.length > 0) {
      await this.sendReply(message.channelId, context, response.text);
    }
  }

  private async sendReply(
    channelId: string,
    context: ConversationState,
    text: string,
  ) {
    const sendResult = await this.adapter.sendMessage(channelId, text);
    if (sendResult.messageId) {
      this.appendHistory(context, {
        id: sendResult.messageId,
        role: "assistant",
        content: text,
        timestamp: Date.now(),
      });
    }
    context.lastResponseAt = Date.now();
  }

  /** Adds a message to the in-memory history and syncs it to memory in the background. */
  private appendHistory(context: ConversationState, message: AgentMessage) {
    context.history.push(message);
    context.history = context.history.slice(-HISTORY_LIMIT);
    void this.ctx.memory
      .syncMessage({ message, channelId: context.channelId, isDm: context.isDm })
      .catch((error: unknown) => {
        this.ctx.logger.warn({ err: error, messageId: message.id }, "Failed to sync message to memory");
      });
  }

  private async backfillMessages(
    channelId: string,
    context: ConversationState,
    beforeMessageId?: string,
    limit = HISTORY_LIMIT,
  ) {
    try {
      const messages = await this.adapter.fetchRecentMessages(
        channelId,
        limit,
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
            const content = msg.content.trim();
            if (content.length === 0) {
              continue;
            }
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
        context.history = context.history.slice(-HISTORY_LIMIT);
        void this.ctx.memory
          .syncMessages(this.toAgentContext(context), newMessages)
          .catch((error: unknown) => {
            this.ctx.logger.warn({ err: error, channelId }, "Failed to sync backfilled messages");
          });
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
      authorId: incoming.authorId,
      author: incoming.authorName,
      timestamp: incoming.timestamp,
    };
    if (incoming.images.length > 0) {
      message.images = incoming.images;
    }
    return message;
  }

  private toAgentContext(state: ConversationState): AgentContext {
    return {
      history: state.history,
      isDm: state.isDm,
      channelId: state.channelId,
    };
  }

  private async handleStartup() {
    const mainChannelId = this.ctx.config.mainChannelId;

    try {
      const context = this.contexts.get(mainChannelId) ?? {
        history: [],
        isDm: false,
        channelId: mainChannelId,
        initialized: false,
      };
      this.contexts.set(mainChannelId, context);
      await this.backfillMessages(mainChannelId, context, undefined, 10);

      const mostRecent = context.history[context.history.length - 1];
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      if (!mostRecent || mostRecent.timestamp < oneDayAgo) {
        return;
      }

      const startupResponse = await this.agent.chatWithContext(
        this.toAgentContext(context),
        {
          systemMessage: `you are samebot, a hyper-intelligent, lowercase-talking friend with a dry, sarcastic British tone.\nCurrent date: ${DateTime.now().toISO()}\nRespond in lowercase only.`,
          userMessage:
            "Generate a brief startup message announcing that samebot has restarted successfully. Keep it short and contextually relevant to the conversation.",
        },
      );

      if (startupResponse.isOk()) {
        await this.sendReply(mainChannelId, context, startupResponse.value);
      } else {
        this.ctx.logger.warn(
          { err: startupResponse.error },
          "Failed to generate startup message",
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
    const contextText = this.agent.formatContextText(agentContext);
    const emojiList = this.agent.buildEmojiList();

    const payload = `=== CONTEXT (${context.history.length} messages) ===\n${contextText}\n\n=== EMOJI ===\n${emojiList || "(none)"}`;

    await interaction.reply({
      content: `\`\`\`\n${payload.slice(-1900)}\n\`\`\``,
      ephemeral: true,
    });
  }

  private async handleAutoReact(message: Message, context: AgentContext) {
    const shouldReact = await this.responseDecision.shouldReact(
      context,
      message.content || "(silent)",
    );
    if (!shouldReact) {
      return;
    }

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
