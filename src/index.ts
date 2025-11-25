import "@total-typescript/ts-reset";
import { loadConfig } from "./core/config";
import { createLogger } from "./core/logger";
import { DiscordGateway } from "./discord/gateway";
import { DiscordMessenger } from "./discord/messenger";
import { OpenAIClient } from "./openai/client";
import { SupabaseClient } from "./supabase/client";
import type { Feature } from "./core/runtime";
import { ConversationFeature } from "./features/conversation";
import { ReactionEchoFeature } from "./features/reaction-echo";
import { ImageCommandFeature } from "./features/image-command";
import { ImageOfDayFeature } from "./features/image-of-day";
import { AgentLaunchFeature } from "./features/agent-launch";
import { DankResponseFeature } from "./features/dank-response";
import { UsaCowboyFeature } from "./features/usa-cowboy";
import { SamebotEmojiFeature } from "./features/samebot-emoji";
import { RobotEmojiReactFeature } from "./features/robot-emoji-react";
import { RememberImageFeature } from "./features/remember-image";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const gateway = new DiscordGateway(config, logger);
  const messenger = new DiscordMessenger(gateway.client, logger);
  const openai = new OpenAIClient(config, logger);
  const supabase = new SupabaseClient(config, logger);

  const conversationFeature = new ConversationFeature();

  const runtime = {
    config,
    logger,
    discord: gateway.client,
    messenger,
    openai,
    supabase,
    conversation: conversationFeature,
    customEmoji: gateway.getCustomEmoji(),
  };

  const features: Feature[] = [
    conversationFeature,
    new ReactionEchoFeature(),
    new ImageCommandFeature(),
    new ImageOfDayFeature(),
    new AgentLaunchFeature(),
    new DankResponseFeature(),
    new UsaCowboyFeature(),
    new SamebotEmojiFeature(),
    new RobotEmojiReactFeature(),
    new RememberImageFeature(),
  ];

  features.forEach((feature) => feature.register(runtime));

  await gateway.start();
}

main().catch((error) => {
  console.error("Fatal error", error);
  process.exitCode = 1;
});
