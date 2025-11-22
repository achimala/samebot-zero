import type { Client, Message, TextBasedChannel } from "discord.js";
import { ResultAsync, err, ok } from "neverthrow";
import type { Logger } from "pino";
import { Errors, type BotError } from "../core/errors";

const DISCORD_LIMIT = 2000;

export class DiscordMessenger {
  constructor(private readonly client: Client, private readonly logger: Logger) {}

  sendToChannel(channelId: string, content: string) {
    return ResultAsync.fromPromise(this.fetchTextChannel(channelId), (error) => {
      this.logger.error({ err: error }, "Failed to fetch channel");
      return Errors.discord("Unable to fetch channel");
    }).andThen((channel) => this.sendContent(channel, content));
  }

  replyToMessage(message: Message, content: string) {
    return this.sendContent(message.channel, content, message);
  }

  sendBuffer(channelId: string, buffer: Buffer, filename: string, description?: string) {
    return ResultAsync.fromPromise(this.fetchTextChannel(channelId), (error) => {
      this.logger.error({ err: error }, "Failed to fetch channel");
      return Errors.discord("Unable to fetch channel for image");
    }).andThen((channel) =>
      ResultAsync.fromPromise(
        channel.send({
          content: description,
          files: [
            {
              attachment: buffer,
              name: filename,
              description
            }
          ]
        }),
        (error) => {
          this.logger.error({ err: error }, "Failed to send attachment");
          return Errors.discord("Unable to send attachment");
        }
      ).map(() => undefined)
    );
  }

  private fetchTextChannel(channelId: string) {
    return this.client.channels.fetch(channelId) as Promise<TextBasedChannel>;
  }

  private sendContent(channel: TextBasedChannel, content: string, replyTo?: Message) {
    const chunks = chunkMessage(content);
    return chunks.reduce<ResultAsync<void, BotError>>((acc, chunk) => {
      return acc.andThen(() =>
        ResultAsync.fromPromise(
          replyTo ? replyTo.reply(chunk) : channel.send(chunk),
          (error) => {
            this.logger.error({ err: error }, "Failed to send message");
            return Errors.discord("Unable to send message");
          }
        ).map(() => undefined)
      );
    }, ok(undefined));
  }
}

function chunkMessage(content: string) {
  if (content.length <= DISCORD_LIMIT) {
    return [content];
  }
  const chunks: string[] = [];
  let remaining = content.trim();
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let sliceIndex = remaining.lastIndexOf("\n", DISCORD_LIMIT);
    if (sliceIndex === -1 || sliceIndex < DISCORD_LIMIT - 200) {
      sliceIndex = DISCORD_LIMIT;
    }
    chunks.push(remaining.slice(0, sliceIndex));
    remaining = remaining.slice(sliceIndex).trimStart();
  }
  return chunks;
}
