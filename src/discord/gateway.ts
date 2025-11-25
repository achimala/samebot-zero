import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ClientEvents,
  type GuildEmoji,
} from "discord.js";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";
import { commandDefinitions } from "./commands";

export class DiscordGateway {
  public readonly client: Client;
  private customEmoji: Map<string, GuildEmoji> = new Map();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  async start() {
    this.client.once("ready", async (client) => {
      this.logger.info({ bot: client.user.tag }, "Discord connected");
      await this.fetchCustomEmoji();
      await this.registerCommands();
    });

    this.client.on("guildCreate", async () => {
      await this.fetchCustomEmoji();
    });

    this.client.on("guildEmojiCreate", async () => {
      await this.fetchCustomEmoji();
    });

    this.client.on("guildEmojiDelete", async () => {
      await this.fetchCustomEmoji();
    });

    this.client.on("guildEmojiUpdate", async () => {
      await this.fetchCustomEmoji();
    });

    await this.client.login(this.config.discordToken);
  }

  getCustomEmoji(): Map<string, GuildEmoji> {
    return this.customEmoji;
  }

  private async fetchCustomEmoji() {
    this.customEmoji.clear();
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await guild.emojis.fetch();
        for (const emoji of guild.emojis.cache.values()) {
          this.customEmoji.set(emoji.name, emoji);
        }
      } catch (error) {
        this.logger.warn(
          { err: error, guildId: guild.id },
          "Failed to fetch emoji from guild",
        );
      }
    }
    this.logger.info(
      { count: this.customEmoji.size },
      "Fetched custom emoji from all guilds",
    );
  }

  on<K extends keyof ClientEvents>(
    event: K,
    listener: (...args: ClientEvents[K]) => void,
  ) {
    this.client.on(event, listener);
  }

  private async registerCommands() {
    const rest = new REST({ version: "10" }).setToken(this.config.discordToken);
    const guildIds = [this.config.mainGuildId, this.config.emojiGuildId];
    for (const guildId of guildIds) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(this.config.discordAppId, guildId),
          { body: commandDefinitions },
        );
        this.logger.info({ guildId }, "Registered guild slash commands");
      } catch (error) {
        this.logger.error(
          { err: error, guildId },
          "Failed to register slash commands",
        );
      }
    }
  }
}
