import {
  Honcho,
  type Peer,
  type Session,
  type PeerContext,
} from "@honcho-ai/sdk";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import type { AgentContext, AgentMessage } from "../agent/types";

const CONTEXT_SEARCH_TOP_K = 10;
const CONTEXT_MAX_CONCLUSIONS = 24;
const CONTEXT_MAX_PARTICIPANTS = 5;
/** Memory is a nice-to-have; never hold up a reply longer than this. */
const CONTEXT_TIMEOUT_MS = 3_000;
const CONTEXT_CACHE_TTL_MS = 5 * 60_000;
const GLOBAL_SEARCH_PEER_LIMIT = 100;

export interface HonchoSearchResult {
  content: string;
  source: "conclusion" | "message";
  peerId?: string;
  peerName?: string;
  createdAt?: string;
}

interface Participant {
  peerId: string;
  displayName: string;
  discordUserId: string;
}

interface SyncMessageInput {
  message: AgentMessage;
  channelId: string;
  isDm: boolean;
}

export class HonchoMemoryService {
  private readonly honcho: Honcho;
  private readonly peerCache = new Map<string, Promise<Peer>>();
  private readonly sessionCache = new Map<string, Promise<Session>>();
  /** Session/peer pairs already registered, so we only call addPeers once. */
  private readonly sessionPeers = new Set<string>();
  private readonly promptContextCache = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  /** In-flight lookups per channel, shared by prefetches and replies. */
  private readonly promptContextLookups = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.honcho = new Honcho({
      apiKey: config.honchoApiKey,
      workspaceId: config.honchoWorkspaceId,
      baseURL: config.honchoUrl,
      environment: "production",
    });
  }

  /**
   * Adds a message to its Honcho session. Pass checkExisting for messages
   * that may already have been synced (e.g. history backfilled on startup).
   */
  async syncMessage(
    input: SyncMessageInput,
    options: { checkExisting?: boolean } = {},
  ): Promise<void> {
    const session = await this.getSession(input.channelId, input.isDm);
    const peer = await this.getMessagePeer(input.message);

    const sessionPeerKey = `${session.id}:${peer.id}`;
    if (!this.sessionPeers.has(sessionPeerKey)) {
      await session.addPeers([
        [
          this.config.honchoAssistantPeerId,
          {
            observeMe: true,
            observeOthers: true,
          },
        ],
        [
          peer.id,
          {
            observeMe: true,
            observeOthers: true,
          },
        ],
      ]);
      this.sessionPeers.add(sessionPeerKey);
    }

    if (options.checkExisting) {
      const existing = await session.messages({
        filters: {
          metadata: {
            discordMessageId: input.message.id,
          },
        },
        size: 1,
      });
      if (existing.length > 0) {
        return;
      }
    }

    const content = this.buildMessageContent(input.message);
    await session.addMessages(
      peer.message(content, {
        createdAt: new Date(input.message.timestamp),
        metadata: {
          source: "samebot-zero",
          discordMessageId: input.message.id,
          discordChannelId: input.channelId,
          discordRole: input.message.role,
          discordAuthorId:
            input.message.role === "assistant"
              ? this.config.honchoAssistantPeerId
              : input.message.authorId,
          discordAuthorName:
            input.message.role === "assistant"
              ? "samebot"
              : input.message.author,
          isDm: input.isDm,
          imageCount: input.message.images?.length ?? 0,
        },
      }),
    );
  }

  async syncMessages(
    context: AgentContext,
    messages: AgentMessage[],
  ): Promise<void> {
    for (const message of messages) {
      await this.syncMessage(
        {
          message,
          channelId: context.channelId,
          isDm: context.isDm,
        },
        { checkExisting: true },
      );
    }
  }

  /**
   * Starts a memory lookup for a channel in the background (if the cache is
   * stale) so it's warm by the time a reply needs it.
   */
  prefetchPromptContext(context: AgentContext): void {
    const cached = this.promptContextCache.get(context.channelId);
    if (cached && cached.expiresAt > Date.now()) {
      return;
    }
    void this.startPromptContextLookup(context).catch(() => undefined);
  }

  /**
   * Memory context for a reply: the session summary plus samebot's model of
   * the most recent participants. Results are cached per channel. If the
   * lookup is slower than CONTEXT_TIMEOUT_MS the reply goes ahead without it,
   * and the lookup keeps running so the cache is warm for the next reply.
   */
  async getPromptContext(context: AgentContext): Promise<string> {
    const cached = this.promptContextCache.get(context.channelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const lookup = this.startPromptContextLookup(context);
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS).unref(),
    );
    const result = await Promise.race([lookup, timeout]).catch(() => null);

    if (result === null) {
      this.logger.warn({}, "Memory context not ready; replying without it");
      return cached?.value ?? "";
    }
    return result;
  }

  private startPromptContextLookup(context: AgentContext): Promise<string> {
    const key = context.channelId;
    const inFlight = this.promptContextLookups.get(key);
    if (inFlight) {
      return inFlight;
    }

    const startedAt = Date.now();
    const lookup = this.buildPromptContext(context, this.buildSearchQuery(context))
      .then((value) => {
        this.promptContextCache.set(key, {
          value,
          expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS,
        });
        this.logger.debug({ ms: Date.now() - startedAt }, "Loaded memory context");
        return value;
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, "Failed to load memory context");
        throw error;
      })
      .finally(() => {
        this.promptContextLookups.delete(key);
      });
    this.promptContextLookups.set(key, lookup);
    return lookup;
  }

  /** Search memory with what's being discussed now, not the whole history. */
  private buildSearchQuery(context: AgentContext): string {
    return context.history
      .filter((message) => message.role === "user")
      .slice(-3)
      .map((message) => message.content)
      .join("\n");
  }

  private async buildPromptContext(
    context: AgentContext,
    searchQuery: string,
  ): Promise<string> {
    const session = await this.getSession(context.channelId, context.isDm);
    const assistant = await this.getAssistantPeer();
    const participants = this.getParticipants(context).slice(
      -CONTEXT_MAX_PARTICIPANTS,
    );

    const summarySection = session.summaries().then((summaries) => {
      const summary = summaries.longSummary ?? summaries.shortSummary;
      return summary ? `Session summary:\n${summary.content}` : "";
    });

    const participantSections = participants.map(async (participant) => {
      const peer = await this.getDiscordPeer(participant);
      const peerContext = await assistant.context({
        target: peer,
        searchQuery,
        searchTopK: CONTEXT_SEARCH_TOP_K,
        includeMostFrequent: true,
        maxConclusions: CONTEXT_MAX_CONCLUSIONS,
      });
      return this.formatPeerContext(
        `Samebot's model of ${participant.displayName}`,
        peerContext,
      );
    });

    const sections = await Promise.allSettled([
      summarySection,
      ...participantSections,
    ]);
    return sections
      .flatMap((section) => {
        if (section.status === "rejected") {
          this.logger.warn({ err: section.reason }, "Memory lookup failed");
          return [];
        }
        return section.value ? [section.value] : [];
      })
      .join("\n\n");
  }

  async searchMemories(
    query: string,
    topK: number,
    context?: AgentContext,
  ): Promise<HonchoSearchResult[]> {
    const assistant = await this.getAssistantPeer();
    const peers =
      context !== undefined
        ? await Promise.all(
            this.getParticipants(context).map((participant) =>
              this.getDiscordPeer(participant),
            ),
          )
        : await this.getKnownDiscordPeers();

    const results: HonchoSearchResult[] = [];
    const seen = new Set<string>();

    for (const peer of peers) {
      const conclusions = await assistant
        .conclusionsOf(peer)
        .query(query, topK);
      for (const conclusion of conclusions) {
        if (seen.has(conclusion.content)) {
          continue;
        }
        seen.add(conclusion.content);
        const result: HonchoSearchResult = {
          content: conclusion.content,
          source: "conclusion",
          peerId: peer.id,
          createdAt: conclusion.createdAt,
        };
        const peerName = this.getPeerDisplayName(peer);
        if (peerName !== undefined) {
          result.peerName = peerName;
        }
        results.push(result);
      }
    }

    const messages = await this.honcho.search(query, { limit: topK });
    for (const message of messages) {
      const content = `${message.peerId}: ${message.content}`;
      if (seen.has(content)) {
        continue;
      }
      seen.add(content);
      results.push({
        content,
        source: "message",
        peerId: message.peerId,
        createdAt: message.createdAt,
      });
    }

    return results.slice(0, topK);
  }

  private async getAssistantPeer(): Promise<Peer> {
    return this.getPeer(this.config.honchoAssistantPeerId, {
      source: "samebot-zero",
      role: "assistant",
      displayName: "samebot",
    });
  }

  private async getMessagePeer(message: AgentMessage): Promise<Peer> {
    if (message.role === "assistant") {
      return this.getAssistantPeer();
    }
    if (!message.authorId) {
      throw new Error(`Cannot sync user message ${message.id} without authorId`);
    }
    return this.getPeer(this.discordPeerId(message.authorId), {
      source: "discord",
      role: "user",
      discordUserId: message.authorId,
      displayName: message.author ?? message.authorId,
    });
  }

  private getDiscordPeer(participant: Participant): Promise<Peer> {
    return this.getPeer(participant.peerId, {
      source: "discord",
      role: "user",
      discordUserId: participant.discordUserId,
      displayName: participant.displayName,
    });
  }

  private getPeer(
    peerId: string,
    metadata: Record<string, unknown>,
  ): Promise<Peer> {
    const cached = this.peerCache.get(peerId);
    if (cached) {
      return cached;
    }

    const peer = this.honcho.peer(peerId, {
      metadata,
      configuration: {
        observeMe: true,
      },
    });
    this.peerCache.set(peerId, peer);
    return peer;
  }

  private getSession(channelId: string, isDm: boolean): Promise<Session> {
    const sessionId = this.sessionId(channelId, isDm);
    const cached = this.sessionCache.get(sessionId);
    if (cached) {
      return cached;
    }

    const session = this.honcho.session(sessionId, {
      metadata: {
        source: "discord",
        discordChannelId: channelId,
        isDm,
      },
      configuration: {
        reasoning: {
          enabled: true,
        },
        peerCard: {
          use: true,
          create: true,
        },
        summary: {
          enabled: true,
        },
        dream: {
          enabled: true,
        },
      },
      peers: [
        [
          this.config.honchoAssistantPeerId,
          {
            observeMe: true,
            observeOthers: true,
          },
        ],
      ],
    });
    this.sessionCache.set(sessionId, session);
    return session;
  }

  private async getKnownDiscordPeers(): Promise<Peer[]> {
    const page = await this.honcho.peers({
      filters: {
        metadata: {
          source: "discord",
        },
      },
      size: GLOBAL_SEARCH_PEER_LIMIT,
    });
    return page.items;
  }

  private getParticipants(context: AgentContext): Participant[] {
    const participants = new Map<string, Participant>();
    for (const message of context.history) {
      if (message.role !== "user" || !message.authorId) {
        continue;
      }
      const peerId = this.discordPeerId(message.authorId);
      // Re-insert so the map ends up ordered by each participant's latest message.
      participants.delete(peerId);
      participants.set(peerId, {
        peerId,
        discordUserId: message.authorId,
        displayName: message.author ?? message.authorId,
      });
    }
    return Array.from(participants.values());
  }

  private formatPeerContext(label: string, context: PeerContext): string {
    const lines: string[] = [];

    if (context.peerCard && context.peerCard.length > 0) {
      lines.push("Peer card:");
      for (const item of context.peerCard) {
        lines.push(`- ${item}`);
      }
    }

    const representation = context.representation?.trim();
    if (representation) {
      lines.push(`Representation:\n${representation}`);
    }

    if (lines.length === 0) {
      return "";
    }

    return `${label}:\n${lines.join("\n")}`;
  }

  private buildMessageContent(message: AgentMessage): string {
    const imageCount = message.images?.length ?? 0;
    if (imageCount === 0) {
      return message.content;
    }
    return `${message.content}\n[${imageCount} image${
      imageCount === 1 ? "" : "s"
    } attached]`;
  }

  private discordPeerId(discordUserId: string): string {
    return `discord-user-${discordUserId}`;
  }

  private sessionId(channelId: string, isDm: boolean): string {
    return isDm ? `discord-dm-${channelId}` : `discord-channel-${channelId}`;
  }

  private getPeerDisplayName(peer: Peer): string | undefined {
    const displayName = peer.metadata?.displayName;
    if (typeof displayName === "string") {
      return displayName;
    }
    return undefined;
  }
}
