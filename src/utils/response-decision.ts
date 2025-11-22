import type { Message } from "discord.js";
import type { ChatMessage } from "../openai/client";
import type { OpenAIClient } from "../openai/client";

export interface TimestampedMessage extends ChatMessage {
  timestamp: number;
}

export interface ConversationContext {
  history: TimestampedMessage[];
  isDm: boolean;
}

export interface ResponseDecisionOptions {
  openai: OpenAIClient;
  botUserId?: string;
}

export class ResponseDecision {
  constructor(private readonly options: ResponseDecisionOptions) {}

  async shouldRespond(
    message: Message,
    context: ConversationContext,
  ): Promise<boolean> {
    if (context.isDm) {
      return true;
    }
    if (!message.inGuild()) {
      return true;
    }
    const content = message.content.toLowerCase();
    if (content.includes("samebot")) {
      return true;
    }
    if (
      this.options.botUserId &&
      message.mentions.users.has(this.options.botUserId)
    ) {
      return true;
    }

    const conversationContext = this.buildConversationContext(context);
    const latestMessageContent = message.content || "(silent)";
    const decision = await this.options.openai.chatStructured<{
      shouldRespond: boolean;
    }>({
      messages: [
        {
          role: "system",
          content: `You are analyzing a Discord conversation to determine if samebot (a bot) should respond to the latest message.

Be CONSERVATIVE. Only return true if:
- It's clearly obvious the user is talking TO samebot or expecting a response FROM samebot
- The message is a direct question or statement directed at samebot
- There's clear context that samebot is part of the conversation

Do NOT return true if:
- Users are just talking to each other
- The message is ambiguous about who it's directed to
- It's just general conversation that happens to mention something samebot might know about
- The message is clearly not directed at samebot

Return false when in doubt.`,
        },
        {
          role: "user",
          content: `Recent conversation context with timing:\n\n${conversationContext}\n\nLatest message: ${latestMessageContent}\n\nShould samebot respond to the latest message?`,
        },
      ],
      schema: {
        type: "object",
        properties: {
          shouldRespond: {
            type: "boolean",
            description: "Whether samebot should respond to the latest message",
          },
        },
        required: ["shouldRespond"],
        additionalProperties: false,
      },
      schemaName: "responseDecision",
      schemaDescription: "Decision on whether samebot should respond",
    });

    return decision.match(
      (result) => result.shouldRespond,
      () => false,
    );
  }

  buildConversationContext(context: ConversationContext): string {
    const now = Date.now();
    const lines: string[] = [];

    for (const message of context.history) {
      const timeAgo = Math.round((now - message.timestamp) / 1000);
      const timeAgoText =
        timeAgo < 60
          ? `${timeAgo}s ago`
          : timeAgo < 3600
            ? `${Math.round(timeAgo / 60)}m ago`
            : `${Math.round(timeAgo / 3600)}h ago`;
      lines.push(`[${timeAgoText}] ${message.role}: ${message.content}`);
    }

    return lines.join("\n");
  }
}
