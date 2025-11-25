import type { Logger } from "pino";
import type { Client, GuildEmoji } from "discord.js";
import type { AppConfig } from "./config";
import type { OpenAIClient } from "../openai/client";
import type { DiscordMessenger } from "../discord/messenger";
import type { SupabaseClient } from "../supabase/client";
import type { ConversationFeature } from "../features/conversation";
import type { MemoryService } from "../memory/service";

export interface RuntimeContext {
  config: AppConfig;
  logger: Logger;
  discord: Client;
  openai: OpenAIClient;
  messenger: DiscordMessenger;
  supabase: SupabaseClient;
  memory: MemoryService;
  conversation?: ConversationFeature;
  customEmoji: Map<string, GuildEmoji>;
}

export interface Feature {
  register(context: RuntimeContext): void;
}
