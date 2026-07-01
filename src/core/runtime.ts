import type { Logger } from "pino";
import type { Client, GuildEmoji } from "discord.js";
import type { AppConfig } from "./config";
import type { OpenAIClient } from "../openai/client";
import type { GeminiClient } from "../gemini/client";
import type { DiscordMessenger } from "../discord/messenger";
import type { SupabaseClient } from "../supabase/client";
import type { ConversationFeature } from "../features/conversation";
import type { HonchoMemoryService } from "../memory/service";
import type { ScrapbookService } from "../scrapbook/service";

export interface RuntimeContext {
  config: AppConfig;
  logger: Logger;
  discord: Client;
  openai: OpenAIClient;
  gemini: GeminiClient;
  messenger: DiscordMessenger;
  supabase: SupabaseClient;
  memory: HonchoMemoryService;
  scrapbook: ScrapbookService;
  conversation?: ConversationFeature;
  customEmoji: Map<string, GuildEmoji>;
}

export interface Feature {
  register(context: RuntimeContext): void;
}
