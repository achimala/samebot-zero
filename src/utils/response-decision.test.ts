import { describe, it, expect } from "vitest";
import {
  ResponseDecision,
  type ConversationContext,
} from "./response-decision";
import type { Message } from "discord.js";
import { OpenAIClient } from "../openai/client";
import { createLogger } from "../core/logger";

function createMockMessage(options: {
  content: string;
  isDm?: boolean;
  mentionsBot?: boolean;
  authorId?: string;
  channelId?: string;
  timestamp?: number;
}): Message {
  const botUserId = "bot123";
  const mentions = new Set<string>();
  if (options.mentionsBot) {
    mentions.add(botUserId);
  }

  return {
    content: options.content,
    author: {
      id: options.authorId || "user123",
      bot: false,
    },
    channelId: options.channelId || "channel123",
    createdTimestamp: options.timestamp || Date.now(),
    mentions: {
      users: {
        has: (id: string) => mentions.has(id),
      },
    },
    inGuild: () => !options.isDm,
  } as unknown as Message;
}

function createOpenAIClient(): OpenAIClient | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  const logger = createLogger("silent");
  return new OpenAIClient(
    {
      openAIApiKey: apiKey,
      discordToken: "",
      discordAppId: "",
      mainChannelId: "",
      imageOfDayChannelId: "",
      logLevel: "silent",
    },
    logger,
  );
}

describe("ResponseDecision", () => {
  const openaiClient = createOpenAIClient();
  const hasOpenAI = openaiClient !== null;

  describe("shouldRespond", () => {
    it("always returns true for DMs", async () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const message = createMockMessage({ content: "hello", isDm: true });
      const context: ConversationContext = {
        history: [],
        isDm: true,
      };

      const result = await decision.shouldRespond(message, context);

      expect(result).toBe(true);
    });

    it("always returns true for non-guild messages", async () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const message = createMockMessage({ content: "hello", isDm: false });
      const context: ConversationContext = {
        history: [],
        isDm: false,
      };

      (message.inGuild as unknown as () => boolean) = () => false;

      const result = await decision.shouldRespond(message, context);

      expect(result).toBe(true);
    });

    it("always returns true when message contains 'samebot'", async () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const message = createMockMessage({
        content: "hey samebot what's up",
        isDm: false,
      });
      const context: ConversationContext = {
        history: [],
        isDm: false,
      };

      const result = await decision.shouldRespond(message, context);

      expect(result).toBe(true);
    });

    it("always returns true when message contains 'samebot' case-insensitive", async () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const message = createMockMessage({
        content: "Hey SAMEBOT can you help?",
        isDm: false,
      });
      const context: ConversationContext = {
        history: [],
        isDm: false,
      };

      const result = await decision.shouldRespond(message, context);

      expect(result).toBe(true);
    });

    it("always returns true when bot is @mentioned", async () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({
        openai: openaiClient,
        botUserId: "bot123",
      });
      const message = createMockMessage({
        content: "hey @bot123",
        isDm: false,
        mentionsBot: true,
      });
      const context: ConversationContext = {
        history: [],
        isDm: false,
      };

      const result = await decision.shouldRespond(message, context);

      expect(result).toBe(true);
    });

    it.concurrent.skipIf(!hasOpenAI)(
      "uses LLM when no explicit triggers",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const message = createMockMessage({
          content: "what's the weather like?",
          isDm: false,
        });
        const now = Date.now();
        const context: ConversationContext = {
          history: [
            { role: "user", content: "alice: hello", timestamp: now - 5000 },
            { role: "assistant", content: "hi there", timestamp: now - 3000 },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
      },
    );
  });

  describe("buildConversationContext", () => {
    it("formats conversation with timing information", () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const now = Date.now();
      const context: ConversationContext = {
        history: [
          { role: "user", content: "alice: hello", timestamp: now - 5000 },
          { role: "assistant", content: "hi there", timestamp: now - 3000 },
          { role: "user", content: "bob: what's up", timestamp: now - 1000 },
        ],
        isDm: false,
      };

      const result = decision.buildConversationContext(context);

      expect(result).toContain("user: alice: hello");
      expect(result).toContain("assistant: hi there");
      expect(result).toContain("user: bob: what's up");
      expect(result).toMatch(/\[\d+s ago\]/);
    });

    it("handles minutes ago format", () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const now = Date.now();
      const context: ConversationContext = {
        history: [
          { role: "user", content: "alice: hello", timestamp: now - 120000 },
        ],
        isDm: false,
      };

      const result = decision.buildConversationContext(context);

      expect(result).toMatch(/\[\d+m ago\]/);
    });

    it("handles hours ago format", () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const now = Date.now();
      const context: ConversationContext = {
        history: [
          { role: "user", content: "alice: hello", timestamp: now - 7200000 },
        ],
        isDm: false,
      };

      const result = decision.buildConversationContext(context);

      expect(result).toMatch(/\[\d+h ago\]/);
    });

    it("includes all messages with timestamps", () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const now = Date.now();
      const context: ConversationContext = {
        history: [
          { role: "user", content: "alice: hello", timestamp: now - 5000 },
          { role: "user", content: "bob: hi", timestamp: now - 3000 },
        ],
        isDm: false,
      };

      const result = decision.buildConversationContext(context);

      expect(result).toContain("alice: hello");
      expect(result).toContain("bob: hi");
    });

    it("handles empty context", () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const context: ConversationContext = {
        history: [],
        isDm: false,
      };

      const result = decision.buildConversationContext(context);

      expect(result).toBe("");
    });
  });

  describe("simulated conversations with LLM", () => {
    it.concurrent.skipIf(!hasOpenAI)(
      "should respond when user asks direct question to bot in active conversation",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "can you explain how this works?",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            {
              role: "user",
              content: "alice: hey samebot, I need help",
              timestamp: now - 10000,
            },
            {
              role: "assistant",
              content: "hi alice, how can I help?",
              timestamp: now - 8000,
            },
            {
              role: "user",
              content: "alice: can you explain how this works?",
              timestamp: now,
            },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(true);
      },
    );

    it.concurrent.skipIf(!hasOpenAI)(
      "should not respond when users are talking to each other",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "yeah that sounds good to me",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            {
              role: "user",
              content: "alice: want to grab lunch?",
              timestamp: now - 15000,
            },
            {
              role: "user",
              content: "bob: sure, where?",
              timestamp: now - 12000,
            },
            {
              role: "user",
              content: "alice: how about the pizza place",
              timestamp: now - 8000,
            },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    it.concurrent.skipIf(!hasOpenAI)(
      "should respond in active conversation thread with clear follow-up",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "what do you think about that explanation?",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            {
              role: "user",
              content: "alice: samebot, explain this concept",
              timestamp: now - 20000,
            },
            {
              role: "assistant",
              content: "here's the explanation...",
              timestamp: now - 15000,
            },
            {
              role: "user",
              content:
                "alice: thanks, one more thing - what do you think about that explanation?",
              timestamp: now,
            },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(true);
      },
    );

    it.concurrent.skipIf(!hasOpenAI)(
      "should not respond to ambiguous messages",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "that's interesting",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            {
              role: "user",
              content: "alice: check out this article",
              timestamp: now - 10000,
            },
            {
              role: "user",
              content: "bob: wow, that's cool",
              timestamp: now - 5000,
            },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    it.concurrent.skipIf(!hasOpenAI)(
      "should respond to clear question directed at bot in active conversation",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "hey, what time is it?",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            {
              role: "user",
              content: "alice: hello samebot",
              timestamp: now - 5000,
            },
            { role: "assistant", content: "hi alice", timestamp: now - 3000 },
            {
              role: "user",
              content: "alice: hey, what time is it?",
              timestamp: now,
            },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(true);
      },
    );

    it.concurrent.skipIf(!hasOpenAI)(
      "should not respond to general conversation",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "sounds like a plan",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            {
              role: "user",
              content: "alice: let's meet at 3pm",
              timestamp: now - 10000,
            },
            { role: "user", content: "bob: perfect", timestamp: now - 5000 },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    it.concurrent.skipIf(!hasOpenAI)(
      "should not respond to ambiguous question without clear context",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "can you help me with something?",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            {
              role: "user",
              content: "alice: hey everyone",
              timestamp: now - 10000,
            },
            {
              role: "user",
              content: "bob: what's going on",
              timestamp: now - 5000,
            },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    it.concurrent.skipIf(!hasOpenAI)(
      "should not respond when question could be for anyone",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "what do you think?",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            {
              role: "user",
              content: "alice: check out this article",
              timestamp: now - 10000,
            },
            {
              role: "user",
              content: "bob: interesting read",
              timestamp: now - 5000,
            },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    it.concurrent.skipIf(!hasOpenAI)(
      "should not respond to standalone question without bot context",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockMessage({
          content: "hey, what time is it?",
          isDm: false,
          timestamp: now,
        });
        const context: ConversationContext = {
          history: [
            { role: "user", content: "alice: hello", timestamp: now - 5000 },
            { role: "user", content: "bob: hi there", timestamp: now - 3000 },
          ],
          isDm: false,
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );
  });
});
