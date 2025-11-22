import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ClientEvents
} from "discord.js";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import { commandDefinitions } from "./commands";

export class DiscordGateway {
  public readonly client: Client;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction]
    });
  }

  async start() {
    this.client.once("ready", async (client) => {
      this.logger.info({ bot: client.user.tag }, "Discord connected");
      await this.registerCommands();
    });

    await this.client.login(this.config.discordToken);
  }

  on<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void) {
    this.client.on(event, listener);
  }

  private async registerCommands() {
    const rest = new REST({ version: "10" }).setToken(this.config.discordToken);
    try {
      await rest.put(Routes.applicationCommands(this.config.discordAppId), {
        body: commandDefinitions
      });
      this.logger.info("Registered global slash commands");
    } catch (error) {
      this.logger.error({ err: error }, "Failed to register slash commands");
    }
  }
}
