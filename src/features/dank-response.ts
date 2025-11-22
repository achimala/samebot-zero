import type { Message } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

const DANK_VARIATIONS = [
  "dankalicious",
  "danktacular",
  "danktastic",
  "dankulous",
  "dankified",
  "danktasticular",
  "dankaliciously",
  "danktacularly",
  "danktastically",
  "dankulousness",
  "dankification",
  "danktasticularity",
  "dankaliciousness",
  "danktacularity",
  "danktasticity",
  "dankulousity",
];

export class DankResponseFeature implements Feature {
  private ctx!: RuntimeContext;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || message.system || !message.inGuild()) {
      return;
    }

    const content = message.content.toLowerCase();
    if (!content.includes("dank")) {
      return;
    }

    const variation =
      DANK_VARIATIONS[Math.floor(Math.random() * DANK_VARIATIONS.length)];

    await this.ctx.messenger.sendToChannel(message.channelId, variation).match(
      async () => undefined,
      async (error) => {
        this.ctx.logger.warn({ err: error }, "Failed to send dank response");
      },
    );
  }
}
