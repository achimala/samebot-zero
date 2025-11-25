import { describe, it, expect } from "vitest";
import { ResponseDecision } from "../agent/response-decision";
import type { AgentContext, IncomingMessage } from "../agent/types";
import { OpenAIClient } from "../openai/client";
import { createLogger } from "../core/logger";

function createMockIncomingMessage(options: {
  content: string;
  isDm?: boolean;
  mentionsBot?: boolean;
  authorId?: string;
  channelId?: string;
  timestamp?: number;
}): IncomingMessage {
  return {
    id: `msg_${Date.now()}`,
    content: options.content,
    authorId: options.authorId || "user123",
    authorName: "TestUser",
    channelId: options.channelId || "channel123",
    timestamp: options.timestamp || Date.now(),
    images: [],
    isDm: options.isDm || false,
    mentionsBotId: options.mentionsBot || false,
  };
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
      googleApiKey: "",
      discordToken: "",
      discordAppId: "",
      cursorApiKey: "",
      supabaseUrl: "",
      supabaseServiceRoleKey: "",
      mainChannelId: "",
      imageOfDayChannelId: "",
      emojiGuildId: "",
      mainGuildId: "",
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
      const message = createMockIncomingMessage({
        content: "hello",
        isDm: true,
      });
      const context: AgentContext = {
        history: [],
        isDm: true,
        channelId: "channel123",
      };

      const result = await decision.shouldRespond(message, context);

      expect(result).toBe(true);
    });

    it("always returns true when message contains 'samebot'", async () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const message = createMockIncomingMessage({
        content: "hey samebot what's up",
        isDm: false,
      });
      const context: AgentContext = {
        history: [],
        isDm: false,
        channelId: "channel123",
      };

      const result = await decision.shouldRespond(message, context);

      expect(result).toBe(true);
    });

    it("always returns true when message contains 'samebot' case-insensitive", async () => {
      if (!openaiClient) {
        return;
      }
      const decision = new ResponseDecision({ openai: openaiClient });
      const message = createMockIncomingMessage({
        content: "Hey SAMEBOT can you help?",
        isDm: false,
      });
      const context: AgentContext = {
        history: [],
        isDm: false,
        channelId: "channel123",
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
      const message = createMockIncomingMessage({
        content: "hey @bot123",
        isDm: false,
        mentionsBot: true,
      });
      const context: AgentContext = {
        history: [],
        isDm: false,
        channelId: "channel123",
      };

      const result = await decision.shouldRespond(message, context);

      expect(result).toBe(true);
    });

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "uses LLM when no explicit triggers",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const message = createMockIncomingMessage({
          content: "what's the weather like?",
          isDm: false,
        });
        const now = Date.now();
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "hello",
              author: "alice",
              timestamp: now - 5000,
            },
            {
              id: "msg2",
              role: "assistant",
              content: "hi there",
              timestamp: now - 3000,
            },
          ],
          isDm: false,
          channelId: "channel123",
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
      const context: AgentContext = {
        history: [
          {
            id: "msg1",
            role: "user",
            content: "hello",
            author: "alice",
            timestamp: now - 5000,
          },
          {
            id: "msg2",
            role: "assistant",
            content: "hi there",
            timestamp: now - 3000,
          },
          {
            id: "msg3",
            role: "user",
            content: "what's up",
            author: "bob",
            timestamp: now - 1000,
          },
        ],
        isDm: false,
        channelId: "channel123",
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
      const context: AgentContext = {
        history: [
          {
            id: "msg1",
            role: "user",
            content: "hello",
            author: "alice",
            timestamp: now - 120000,
          },
        ],
        isDm: false,
        channelId: "channel123",
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
      const context: AgentContext = {
        history: [
          {
            id: "msg1",
            role: "user",
            content: "hello",
            author: "alice",
            timestamp: now - 7200000,
          },
        ],
        isDm: false,
        channelId: "channel123",
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
      const context: AgentContext = {
        history: [
          {
            id: "msg1",
            role: "user",
            content: "hello",
            author: "alice",
            timestamp: now - 5000,
          },
          {
            id: "msg2",
            role: "user",
            content: "hi",
            author: "bob",
            timestamp: now - 3000,
          },
        ],
        isDm: false,
        channelId: "channel123",
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
      const context: AgentContext = {
        history: [],
        isDm: false,
        channelId: "channel123",
      };

      const result = decision.buildConversationContext(context);

      expect(result).toBe("");
    });
  });

  describe("simulated conversations with LLM", () => {
    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should respond when user asks direct question to bot in active conversation",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "can you explain how this works?",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "hey samebot, I need help",
              author: "alice",
              timestamp: now - 10000,
            },
            {
              id: "msg2",
              role: "assistant",
              content: "hi alice, how can I help?",
              timestamp: now - 8000,
            },
            {
              id: "msg3",
              role: "user",
              content: "can you explain how this works?",
              author: "alice",
              timestamp: now,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(true);
      },
    );

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should not respond when users are talking to each other",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "yeah that sounds good to me",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "want to grab lunch?",
              author: "alice",
              timestamp: now - 15000,
            },
            {
              id: "msg2",
              role: "user",
              content: "sure, where?",
              author: "bob",
              timestamp: now - 12000,
            },
            {
              id: "msg3",
              role: "user",
              content: "how about the pizza place",
              author: "alice",
              timestamp: now - 8000,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should respond in active conversation thread with clear follow-up",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "what do you think about that explanation?",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "samebot, explain this concept",
              author: "alice",
              timestamp: now - 20000,
            },
            {
              id: "msg2",
              role: "assistant",
              content: "here's the explanation...",
              timestamp: now - 15000,
            },
            {
              id: "msg3",
              role: "user",
              content:
                "thanks, one more thing - what do you think about that explanation?",
              author: "alice",
              timestamp: now,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(true);
      },
    );

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should not respond to ambiguous messages",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "that's interesting",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "check out this article",
              author: "alice",
              timestamp: now - 10000,
            },
            {
              id: "msg2",
              role: "user",
              content: "wow, that's cool",
              author: "bob",
              timestamp: now - 5000,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should respond to clear question directed at bot in active conversation",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "hey, what time is it?",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "hello samebot",
              author: "alice",
              timestamp: now - 5000,
            },
            {
              id: "msg2",
              role: "assistant",
              content: "hi alice",
              timestamp: now - 3000,
            },
            {
              id: "msg3",
              role: "user",
              content: "hey, what time is it?",
              author: "alice",
              timestamp: now,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(true);
      },
    );

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should not respond to general conversation",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "sounds like a plan",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "let's meet at 3pm",
              author: "alice",
              timestamp: now - 10000,
            },
            {
              id: "msg2",
              role: "user",
              content: "perfect",
              author: "bob",
              timestamp: now - 5000,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should not respond to ambiguous question without clear context",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "can you help me with something?",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "hey everyone",
              author: "alice",
              timestamp: now - 10000,
            },
            {
              id: "msg2",
              role: "user",
              content: "what's going on",
              author: "bob",
              timestamp: now - 5000,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should not respond when question could be for anyone",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "what do you think?",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "check out this article",
              author: "alice",
              timestamp: now - 10000,
            },
            {
              id: "msg2",
              role: "user",
              content: "interesting read",
              author: "bob",
              timestamp: now - 5000,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );

    (hasOpenAI ? it.concurrent : it.concurrent.skip)(
      "should not respond to standalone question without bot context",
      async () => {
        const decision = new ResponseDecision({
          openai: openaiClient!,
          botUserId: "bot123",
        });
        const now = Date.now();
        const message = createMockIncomingMessage({
          content: "hey, what time is it?",
          isDm: false,
          timestamp: now,
        });
        const context: AgentContext = {
          history: [
            {
              id: "msg1",
              role: "user",
              content: "hello",
              author: "alice",
              timestamp: now - 5000,
            },
            {
              id: "msg2",
              role: "user",
              content: "hi there",
              author: "bob",
              timestamp: now - 3000,
            },
          ],
          isDm: false,
          channelId: "channel123",
        };

        const result = await decision.shouldRespond(message, context);

        expect(typeof result).toBe("boolean");
        expect(result).toBe(false);
      },
    );
  });
});
