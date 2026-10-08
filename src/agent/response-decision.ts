import type { Logger } from "pino";
import type { DecisionClient } from "../llm/decisions";
import type { AgentContext, IncomingMessage } from "./types";

const RESPOND_THRESHOLD = 0.6;
const BRIEF_REPLY_THRESHOLD = 0.7;
const REACT_THRESHOLD = 0.6;
const CONTEXT_MESSAGES = 15;

export interface ResponseDecisionOptions {
  decisions: DecisionClient;
  botUserId?: string;
  logger?: Logger;
}

/**
 * Cheap routing decisions for incoming messages, backed by the Decisions API
 * rather than a chat model. Every method fails closed (no reply / no react).
 */
export class ResponseDecision {
  constructor(private readonly options: ResponseDecisionOptions) {}

  async shouldRespond(
    message: IncomingMessage,
    context: AgentContext,
  ): Promise<boolean> {
    if (context.isDm) {
      this.options.logger?.debug({}, "Responding: message is a DM");
      return true;
    }

    const content = message.content.toLowerCase();
    if (content.includes("samebot")) {
      this.options.logger?.debug({}, "Responding: message contains 'samebot'");
      return true;
    }

    if (message.mentionsBotId) {
      this.options.logger?.debug({}, "Responding: bot is mentioned");
      return true;
    }

    const previousMessage = context.history[context.history.length - 2];
    if (!previousMessage || previousMessage.role !== "assistant") {
      this.options.logger?.debug(
        {},
        "Not responding: previous message in history is not from samebot",
      );
      return false;
    }

    const result = await this.options.decisions.decide(
      this.buildDecisionInput(context, message.content),
      [
        {
          type: "predicate",
          name: "should_respond",
          instructions:
            "Is the latest message clearly directed at samebot, or clearly expecting a reply from samebot? Answer false if people are just talking to each other or it is ambiguous who the message is for.",
        },
      ],
    );

    return result.match(
      (answers) => {
        const probability = answers.probability("should_respond") ?? 0;
        this.options.logger?.debug(
          { probability },
          "Response decision",
        );
        return probability >= RESPOND_THRESHOLD;
      },
      () => false,
    );
  }

  /** Whether a quick "same"-style agreement fits better than a full reply. */
  async shouldReplyBriefly(
    context: AgentContext,
    latestMessageContent: string,
  ): Promise<boolean> {
    const result = await this.options.decisions.decide(
      this.buildDecisionInput(context, latestMessageContent),
      [
        {
          type: "predicate",
          name: "brief_reply_fits",
          instructions:
            "Would samebot replying with just a casual 'same' (or similar one-to-three word agreement) be a natural, fitting reply to the latest message? Answer false if the message asks a question, needs a substantive answer, or samebot already said 'same' recently.",
        },
      ],
    );

    return result.match(
      (answers) =>
        (answers.probability("brief_reply_fits") ?? 0) >= BRIEF_REPLY_THRESHOLD,
      () => false,
    );
  }

  async shouldReact(
    context: AgentContext,
    latestMessageContent: string,
  ): Promise<boolean> {
    const result = await this.options.decisions.decide(
      this.buildDecisionInput(context, latestMessageContent),
      [
        {
          type: "predicate",
          name: "should_react",
          instructions:
            "Would an emoji reaction from samebot on the latest message feel fun and natural (e.g. it is funny, notable, or emotionally expressive)?",
        },
      ],
    );
    return result.match(
      (answers) => (answers.probability("should_react") ?? 0) >= REACT_THRESHOLD,
      () => false,
    );
  }

  buildDecisionInput(context: AgentContext, latestMessageContent: string) {
    return `Discord group chat. samebot is a sarcastic British bot who participates in the conversation.

Recent conversation:
${this.buildConversationContext(context)}

Latest message: ${latestMessageContent || "(silent)"}`;
  }

  buildConversationContext(context: AgentContext): string {
    const now = Date.now();
    const lines: string[] = [];

    for (const message of context.history.slice(-CONTEXT_MESSAGES)) {
      if (message.role === "assistant" && message.content === "(silent)") {
        continue;
      }

      const timeAgo = Math.round((now - message.timestamp) / 1000);
      const timeAgoText =
        timeAgo < 60
          ? `${timeAgo}s ago`
          : timeAgo < 3600
            ? `${Math.round(timeAgo / 60)}m ago`
            : `${Math.round(timeAgo / 3600)}h ago`;

      const author =
        message.role === "assistant" ? "samebot" : (message.author ?? "user");

      lines.push(`[${timeAgoText}] ${author}: ${message.content}`);
    }

    return lines.join("\n");
  }
}
