import "@total-typescript/ts-reset";
import { loadConfig } from "./core/config";
import { createLogger } from "./core/logger";
import { DiscordGateway } from "./discord/gateway";
import { DiscordMessenger } from "./discord/messenger";
import { OpenAIClient } from "./openai/client";
import type { Feature } from "./core/runtime";
import { ConversationFeature } from "./features/conversation";
import { AutoReactFeature } from "./features/auto-react";
import { ReactionEchoFeature } from "./features/reaction-echo";
import { ImageCommandFeature } from "./features/image-command";
import { ImageOfDayFeature } from "./features/image-of-day";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const gateway = new DiscordGateway(config, logger);
  const messenger = new DiscordMessenger(gateway.client, logger);
  const openai = new OpenAIClient(config, logger);

  const runtime = {
    config,
    logger,
    discord: gateway.client,
    messenger,
    openai,
  };

  const features: Feature[] = [
    new ConversationFeature(),
    new AutoReactFeature(),
    new ReactionEchoFeature(),
    new ImageCommandFeature(),
    new ImageOfDayFeature(),
  ];

  features.forEach((feature) => feature.register(runtime));

  await gateway.start();
}

main().catch((error) => {
  console.error("Fatal error", error);
  process.exitCode = 1;
});
