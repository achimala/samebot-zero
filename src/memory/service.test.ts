import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HonchoMemoryService } from "./service";
import { createLogger } from "../core/logger";
import type { AppConfig } from "../core/config";
import type { AgentContext } from "../agent/types";

const honchoTiming = vi.hoisted(() => ({ lookupDurationMs: 0 }));

vi.mock("@honcho-ai/sdk", () => ({
  Honcho: class {
    async session() {
      return {
        id: "session",
        summaries: () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ shortSummary: { content: "they talk about memes" } }),
              honchoTiming.lookupDurationMs,
            ),
          ),
      };
    }
    async peer() {
      return { id: "samebot" };
    }
  },
}));

const testConfig: AppConfig = {
  discordToken: "",
  discordAppId: "",
  anthropicApiKey: "",
  openAIApiKey: "",
  googleApiKey: "",
  cursorApiKey: "",
  supabaseUrl: "",
  supabaseServiceRoleKey: "",
  supabaseDbConnectionUri: "",
  honchoUrl: "",
  honchoApiKey: "",
  honchoWorkspaceId: "",
  honchoAssistantPeerId: "samebot",
  mainChannelId: "",
  imageOfDayChannelId: "",
  emojiGuildId: "",
  mainGuildId: "",
  logLevel: "silent",
};

const context: AgentContext = { history: [], isDm: false, channelId: "channel" };

async function requestContextOneSecondAfterPrefetch() {
  const service = new HonchoMemoryService(testConfig, createLogger("silent"));
  service.prefetchPromptContext(context);
  await vi.advanceTimersByTimeAsync(1_000);
  const promptContext = service.getPromptContext(context);
  await vi.advanceTimersByTimeAsync(10_000);
  return promptContext;
}

describe("HonchoMemoryService.getPromptContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a typical ~5s prefetched lookup", async () => {
    honchoTiming.lookupDurationMs = 5_000;

    expect(await requestContextOneSecondAfterPrefetch()).toBe(
      "Session summary:\nthey talk about memes",
    );
  });

  it("replies without memory once the lookup overruns its budget", async () => {
    honchoTiming.lookupDurationMs = 8_000;

    expect(await requestContextOneSecondAfterPrefetch()).toBe("");
  });
});
