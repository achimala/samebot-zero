import { describe, expect, it } from "vitest";
import { ScrapbookService } from "./service";
import type { ScrapbookMemory, ScrapbookStore } from "./store";
import { DecisionClient } from "../llm/decisions";
import { createLogger } from "../core/logger";
import type { AppConfig } from "../core/config";

const testConfig: AppConfig = {
  discordToken: "",
  discordAppId: "",
  anthropicApiKey: "",
  openAIApiKey: "unused",
  googleApiKey: "",
  cursorApiKey: "",
  supabaseUrl: "",
  supabaseServiceRoleKey: "",
  supabaseDbConnectionUri: "",
  honchoUrl: "",
  honchoApiKey: "",
  honchoWorkspaceId: "",
  honchoAssistantPeerId: "",
  mainChannelId: "",
  imageOfDayChannelId: "",
  emojiGuildId: "",
  mainGuildId: "",
  logLevel: "silent",
};

class InMemoryScrapbookStore implements ScrapbookStore {
  readonly memories: ScrapbookMemory[] = [];

  async insert(memory: Omit<ScrapbookMemory, "id">): Promise<string> {
    const id = String(this.memories.length + 1);
    this.memories.push({ ...memory, id });
    return id;
  }

  async getByQuote(quote: string): Promise<ScrapbookMemory | null> {
    return this.memories.find((memory) => memory.keyMessage === quote) ?? null;
  }

  async delete(): Promise<void> {}
  async getRandom(): Promise<ScrapbookMemory | null> {
    return null;
  }
  async search(): Promise<ScrapbookMemory[]> {
    return [];
  }
  async getById(): Promise<ScrapbookMemory | null> {
    return null;
  }
}

function createService(store: ScrapbookStore) {
  const logger = createLogger("silent");
  return new ScrapbookService(store, new DecisionClient(testConfig, logger), logger);
}

describe("ScrapbookService.saveMemory", () => {
  const keyMessage = {
    id: "1",
    author: "alice",
    content: "that is a proper spicy meme",
    timestamp: 1_000,
  };
  const messages = [
    keyMessage,
    { id: "2", author: "bob", content: "lol", timestamp: 2_000 },
  ];

  it("does not save a quote that a previous run already saved", async () => {
    const store = new InMemoryScrapbookStore();

    expect(await createService(store).saveMemory(keyMessage, messages)).toBe("1");
    // A restarted process starts with fresh in-memory state but the same history.
    expect(await createService(store).saveMemory(keyMessage, messages)).toBeNull();
    expect(store.memories).toHaveLength(1);
  });
});
