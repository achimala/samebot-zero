import type { Logger } from "pino";
import type { Client } from "discord.js";
import type { AppConfig } from "./config";
import type { OpenAIClient } from "../openai/client";
import type { DiscordMessenger } from "../discord/messenger";

export interface RuntimeContext {
  config: AppConfig;
  logger: Logger;
  discord: Client;
  openai: OpenAIClient;
  messenger: DiscordMessenger;
}

export interface Feature {
  register(context: RuntimeContext): void;
}
