import type { Client, Message, TextBasedChannel } from "discord.js";
import { ResultAsync, err } from "neverthrow";
import type { Logger } from "pino";
import { Errors, type BotError } from "../core/errors";

const DISCORD_LIMIT = 2000;

export class DiscordMessenger {
  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  sendToChannel(channelId: string, content: string) {
    return ResultAsync.fromPromise(
      this.fetchTextChannel(channelId),
      (error) => {
        this.logger.error({ err: error }, "Failed to fetch channel");
        return Errors.discord("Unable to fetch channel");
      },
    ).andThen((channel) => {
      return this.sendContent(channel, content);
    });
  }

  replyToMessage(message: Message, content: string) {
    return this.sendContent(message.channel, content, message);
  }

  sendBuffer(
    channelId: string,
    buffer: Buffer,
    filename: string,
    description?: string,
  ) {
    return ResultAsync.fromPromise(
      this.fetchTextChannel(channelId),
      (error) => {
        this.logger.error({ err: error }, "Failed to fetch channel");
        return Errors.discord("Unable to fetch channel for image");
      },
    ).andThen((channel) => {
      const filePayload: {
        attachment: Buffer;
        name: string;
        description?: string;
      } = {
        attachment: buffer,
        name: filename,
      };
      if (description !== undefined) {
        filePayload.description = description;
      }
      const sendOptions: { files: (typeof filePayload)[]; content?: string } = {
        files: [filePayload],
      };
      if (description !== undefined) {
        sendOptions.content = description;
      }
      const sendPromise: Promise<Message> = channel.send(sendOptions);
      return ResultAsync.fromPromise(sendPromise, (error) => {
        this.logger.error({ err: error }, "Failed to send attachment");
        return Errors.discord("Unable to send attachment");
      }).map<void>(() => undefined);
    });
  }

  private fetchTextChannel(channelId: string) {
    return this.client.channels.fetch(channelId) as Promise<TextBasedChannel>;
  }

  private sendContent(
    channel: TextBasedChannel,
    content: string,
    replyTo?: Message,
  ) {
    const chunks = chunkMessage(content);
    return chunks.reduce<ResultAsync<void, BotError>>(
      (acc, chunk) => {
        return acc.andThen(() => {
          if (replyTo) {
            const replyPromise: Promise<Message> = replyTo.reply(chunk);
            return ResultAsync.fromPromise(replyPromise, (error) => {
              this.logger.error({ err: error }, "Failed to send message");
              return Errors.discord("Unable to send message");
            }).map<void>(() => undefined);
          }
          const sendPromise: Promise<Message> = channel.send(chunk);
          return ResultAsync.fromPromise(sendPromise, (error) => {
            this.logger.error({ err: error }, "Failed to send message");
            return Errors.discord("Unable to send message");
          }).map<void>(() => undefined);
        });
      },
      ResultAsync.fromSafePromise<void>(Promise.resolve(undefined)),
    );
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
