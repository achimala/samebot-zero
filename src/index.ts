import "@total-typescript/ts-reset";
import { loadConfig } from "./core/config";
import { DeploymentLock } from "./core/deployment-lock";
import { createLogger } from "./core/logger";
import { DiscordGateway } from "./discord/gateway";
import { DiscordMessenger } from "./discord/messenger";
import { OpenAIClient } from "./openai/client";
import { GeminiClient } from "./gemini/client";
import { SupabaseClient } from "./supabase/client";
import type { Feature } from "./core/runtime";
import { ConversationFeature } from "./features/conversation";
import { ImageCommandFeature } from "./features/image-command";
import { ImageOfDayFeature } from "./features/image-of-day";
import { AgentLaunchFeature } from "./features/agent-launch";
import { DankResponseFeature } from "./features/dank-response";
import { UsaCowboyFeature } from "./features/usa-cowboy";
import { SamebotEmojiFeature } from "./features/samebot-emoji";
import { GifEmojiFeature } from "./features/gif-emoji";
import { GifCommandFeature } from "./features/gif-command";
import { VideoCommandFeature } from "./features/video-command";
import { RobotEmojiReactFeature } from "./features/robot-emoji-react";
import { RememberImageFeature } from "./features/remember-image";
import { ScrapbookFeature } from "./features/scrapbook";
import { HonchoMemoryService } from "./memory/service";
import { SupabaseScrapbookStore } from "./scrapbook/supabase-store";
import { ScrapbookService } from "./scrapbook/service";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const gateway = new DiscordGateway(config, logger);
  const deploymentLock = new DeploymentLock(
    config.supabaseDbConnectionUri,
    logger,
  );
  const messenger = new DiscordMessenger(gateway.client, logger);
  const openai = new OpenAIClient(config, logger);
  const gemini = new GeminiClient(config, logger);
  const supabase = new SupabaseClient(config, logger);

  const memoryService = new HonchoMemoryService(config, logger);

  const scrapbookStore = new SupabaseScrapbookStore(
    supabase.getClient(),
    logger,
  );
  const scrapbookService = new ScrapbookService(scrapbookStore, openai, logger);

  const conversationFeature = new ConversationFeature();

  const runtime = {
    config,
    logger,
    discord: gateway.client,
    messenger,
    openai,
    gemini,
    supabase,
    memory: memoryService,
    scrapbook: scrapbookService,
    conversation: conversationFeature,
    customEmoji: gateway.getCustomEmoji(),
  };

  const features: Feature[] = [
    conversationFeature,
    new ImageCommandFeature(),
    new ImageOfDayFeature(),
    new AgentLaunchFeature(),
    new DankResponseFeature(),
    new UsaCowboyFeature(),
    new SamebotEmojiFeature(),
    new GifEmojiFeature(),
    new GifCommandFeature(),
    new VideoCommandFeature(),
    new RobotEmojiReactFeature(),
    new RememberImageFeature(),
    new ScrapbookFeature(),
  ];

  features.forEach((feature) => feature.register(runtime));

  await deploymentLock.acquire();
  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, "Shutting down Samebot");
    await gateway.client.destroy();
    await deploymentLock.release();
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await gateway.start();
}

main().catch((error) => {
  console.error("Fatal error", error);
  process.exitCode = 1;
});
