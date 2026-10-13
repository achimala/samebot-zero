import type { Logger } from "pino";
import type { DecisionClient } from "../llm/decisions";
import type { AgentContext, IncomingMessage } from "./types";

const RESPOND_THRESHOLD = 0.6;
const FOLLOW_UP_WINDOW_MS = 3 * 60 * 1000;
const BRIEF_REPLY_THRESHOLD = 0.7;
const REACT_THRESHOLD = 0.6;
const CONTEXT_MESSAGES = 15;

const SETTING =
  "A Discord group chat of friends. samebot is a dry, sarcastic bot in the chat. People find it annoying when it chimes in uninvited, so it should only speak when someone actually wants something from it.";

export interface ResponseDecisionOptions {
  decisions: DecisionClient;
  botUserId?: string;
  logger?: Logger;
}

/** A chat message as the decision model sees it. */
export interface DecisionMessage {
  author: string;
  seconds_ago: number;
  text: string;
}

/**
 * Cheap routing decisions for incoming messages, backed by a decision model
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
    // Only a live back-and-forth counts. Otherwise the first message after
    // a scheduled post hours earlier looks like a reply to samebot.
    if (message.timestamp - previousMessage.timestamp > FOLLOW_UP_WINDOW_MS) {
      this.options.logger?.debug(
        {},
        "Not responding: samebot's last message is too old for a follow-up",
      );
      return false;
    }

    const result = await this.options.decisions.decide(
      this.buildDecisionState(context, message.content),
      {
        should_respond: {
          type: "noul",
          instructions:
            "samebot spoke just before the latest message. Should samebot reply to the latest message?",
          criteria: {
            true: "The latest message asks samebot a question, asks it to do something, or clearly needs an answer from samebot.",
            false:
              "People are talking to each other, it's unclear who it's for, it's only a reaction or opinion (\"nice\", \"lol\", \"fair\", \"thanks\"), or it tells samebot to stop or be quiet.",
          },
        },
      },
    );

    return result.match(
      (answers) => {
        const probability = answers.probability("should_respond") ?? 0;
        this.options.logger?.info(
          { probability, messageId: message.id },
          "Follow-up response decision",
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
      this.buildDecisionState(context, latestMessageContent),
      {
        brief_reply_fits: {
          type: "noul",
          instructions:
            "Would samebot replying with just a casual 'same' (or a similar one-to-three word agreement) be a natural reply to the latest message?",
          criteria: {
            true: "The latest message states a feeling, take or experience that a friend could just agree with.",
            false:
              "The message asks a question, needs a substantive answer, or samebot already said 'same' recently.",
          },
        },
      },
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
      this.buildDecisionState(context, latestMessageContent),
      {
        should_react: {
          type: "noul",
          instructions:
            "Would an emoji reaction from samebot on the latest message feel fun and natural?",
          criteria: {
            true: "The message is funny, notable, or emotionally expressive.",
            false: "The message is routine or logistical.",
          },
        },
      },
    );
    return result.match(
      (answers) => (answers.probability("should_react") ?? 0) >= REACT_THRESHOLD,
      () => false,
    );
  }

  buildDecisionState(context: AgentContext, latestMessageContent: string) {
    const recent = this.buildRecentMessages(context);
    return {
      setting: SETTING,
      recent_messages: recent,
      latest_message: {
        author: recent.at(-1)?.author ?? "user",
        text: latestMessageContent || "(no text)",
      },
    };
  }

  /** The last few messages, oldest first, ending with the latest. */
  buildRecentMessages(context: AgentContext): DecisionMessage[] {
    const now = Date.now();
    return context.history
      .slice(-CONTEXT_MESSAGES)
      .filter(
        (message) =>
          !(message.role === "assistant" && message.content === "(silent)"),
      )
      .map((message) => ({
        author:
          message.role === "assistant" ? "samebot" : (message.author ?? "user"),
        seconds_ago: Math.max(0, Math.round((now - message.timestamp) / 1000)),
        text: message.content,
      }));
  }
}
