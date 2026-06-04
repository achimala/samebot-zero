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
const MAX_RELATIONSHIP_CONTEXTS = 24;
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

  async syncMessage(input: SyncMessageInput): Promise<void> {
    const session = await this.getSession(input.channelId, input.isDm);
    const peer = await this.getMessagePeer(input.message);

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
      await this.syncMessage({
        message,
        channelId: context.channelId,
        isDm: context.isDm,
      });
    }
  }

  async getPromptContext(
    context: AgentContext,
    searchQuery: string,
  ): Promise<string> {
    const session = await this.getSession(context.channelId, context.isDm);
    const assistant = await this.getAssistantPeer();
    const participants = this.getParticipants(context);
    const sections: string[] = [];

    const summaries = await session.summaries();
    if (summaries.longSummary) {
      sections.push(`Session summary:\n${summaries.longSummary.content}`);
    } else if (summaries.shortSummary) {
      sections.push(`Session summary:\n${summaries.shortSummary.content}`);
    }

    for (const participant of participants) {
      const peer = await this.getDiscordPeer(participant);
      const peerContext = await assistant.context({
        target: peer,
        searchQuery,
        searchTopK: CONTEXT_SEARCH_TOP_K,
        includeMostFrequent: true,
        maxConclusions: CONTEXT_MAX_CONCLUSIONS,
      });
      const formatted = this.formatPeerContext(
        `Samebot's model of ${participant.displayName}`,
        peerContext,
      );
      if (formatted) {
        sections.push(formatted);
      }
    }

    let relationshipContexts = 0;
    for (const observer of participants) {
      for (const observed of participants) {
        if (observer.peerId === observed.peerId) {
          continue;
        }
        if (relationshipContexts >= MAX_RELATIONSHIP_CONTEXTS) {
          break;
        }

        const observerPeer = await this.getDiscordPeer(observer);
        const observedPeer = await this.getDiscordPeer(observed);
        const peerContext = await observerPeer.context({
          target: observedPeer,
          searchQuery,
          searchTopK: CONTEXT_SEARCH_TOP_K,
          includeMostFrequent: true,
          maxConclusions: CONTEXT_MAX_CONCLUSIONS,
        });
        const formatted = this.formatPeerContext(
          `${observer.displayName}'s model of ${observed.displayName}`,
          peerContext,
        );
        if (formatted) {
          sections.push(formatted);
          relationshipContexts++;
        }
      }
      if (relationshipContexts >= MAX_RELATIONSHIP_CONTEXTS) {
        break;
      }
    }

    return sections.join("\n\n");
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
