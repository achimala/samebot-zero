import type {
  Client,
  Message,
  TextBasedChannel,
  PartialGroupDMChannel,
} from "discord.js";
import { ChannelType } from "discord.js";
import { ResultAsync, err } from "neverthrow";
import type { Logger } from "pino";
import { Errors, type BotError } from "../core/errors";

const DISCORD_LIMIT = 2000;

type SendableChannel = Exclude<TextBasedChannel, PartialGroupDMChannel>;

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

  sendToChannelWithId(channelId: string, content: string) {
    return ResultAsync.fromPromise(
      this.fetchTextChannel(channelId),
      (error) => {
        this.logger.error({ err: error }, "Failed to fetch channel");
        return Errors.discord("Unable to fetch channel");
      },
    ).andThen((channel) => {
      const sendableChannel = this.assertSendableChannel(channel);
      if (sendableChannel === null) {
        return err(Errors.discord("Channel does not support sending messages"));
      }
      const sendPromise: Promise<Message> = sendableChannel.send(content);
      return ResultAsync.fromPromise(sendPromise, (error) => {
        this.logger.error({ err: error }, "Failed to send message");
        return Errors.discord("Unable to send message");
      }).map((message) => ({ messageId: message.id }));
    });
  }

  editMessage(channelId: string, messageId: string, content: string) {
    return ResultAsync.fromPromise(
      this.fetchTextChannel(channelId),
      (error) => {
        this.logger.error({ err: error }, "Failed to fetch channel");
        return Errors.discord("Unable to fetch channel");
      },
    ).andThen((channel) => {
      const sendableChannel = this.assertSendableChannel(channel);
      if (sendableChannel === null) {
        return err(Errors.discord("Channel does not support sending messages"));
      }
      return ResultAsync.fromPromise(
        sendableChannel.messages.fetch(messageId),
        (error) => {
          this.logger.error({ err: error }, "Failed to fetch message");
          return Errors.discord("Unable to fetch message");
        },
      ).andThen((message) => {
        const editPromise: Promise<Message> = message.edit(content);
        return ResultAsync.fromPromise(editPromise, (error) => {
          this.logger.error({ err: error }, "Failed to edit message");
          return Errors.discord("Unable to edit message");
        }).map<void>(() => undefined);
      });
    });
  }

  editMessageWithFiles(
    channelId: string,
    messageId: string,
    buffer: Buffer,
    filename: string,
    description?: string,
  ) {
    return ResultAsync.fromPromise(
      this.fetchTextChannel(channelId),
      (error) => {
        this.logger.error({ err: error }, "Failed to fetch channel");
        return Errors.discord("Unable to fetch channel");
      },
    ).andThen((channel) => {
      const sendableChannel = this.assertSendableChannel(channel);
      if (sendableChannel === null) {
        return err(Errors.discord("Channel does not support sending messages"));
      }
      return ResultAsync.fromPromise(
        sendableChannel.messages.fetch(messageId),
        (error) => {
          this.logger.error({ err: error }, "Failed to fetch message");
          return Errors.discord("Unable to fetch message");
        },
      ).andThen((message) => {
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
        const editPromise: Promise<Message> = message.edit({
          content: "",
          files: [filePayload],
        });
        return ResultAsync.fromPromise(editPromise, (error) => {
          this.logger.error({ err: error }, "Failed to edit message");
          return Errors.discord("Unable to edit message");
        }).map<void>(() => undefined);
      });
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
      const sendOptions: { files: (typeof filePayload)[] } = {
        files: [filePayload],
      };
      const sendableChannel = this.assertSendableChannel(channel);
      if (sendableChannel === null) {
        return err(Errors.discord("Channel does not support sending messages"));
      }
      const sendPromise: Promise<Message> = sendableChannel.send(sendOptions);
      return ResultAsync.fromPromise(sendPromise, (error) => {
        this.logger.error({ err: error }, "Failed to send attachment");
        return Errors.discord("Unable to send attachment");
      }).map((message) => ({ messageId: message.id }));
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
          const sendableChannel = this.assertSendableChannel(channel);
          if (sendableChannel === null) {
            return err(
              Errors.discord("Channel does not support sending messages"),
            );
          }
          const sendPromise: Promise<Message> = sendableChannel.send(chunk);
          return ResultAsync.fromPromise(sendPromise, (error) => {
            this.logger.error({ err: error }, "Failed to send message");
            return Errors.discord("Unable to send message");
          }).map<void>(() => undefined);
        });
      },
      ResultAsync.fromSafePromise<void>(Promise.resolve(undefined)),
    );
  }

  private isSendableChannel(
    channel: TextBasedChannel,
  ): channel is SendableChannel {
    const type = channel.type;
    if (channel.partial && type === ChannelType.GroupDM) {
      return false;
    }
    return true;
  }

  private assertSendableChannel(
    channel: TextBasedChannel,
  ): SendableChannel | null {
    if (this.isSendableChannel(channel)) {
      return channel;
    }
    return null;
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
