import type { Message } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

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

    const conversationContext = this.ctx.conversation?.getContext(
      message.channelId,
    );

    const contextText = conversationContext
      ? this.ctx.conversation.formatContext(conversationContext)
      : "No recent conversation context.";

    const response = await this.ctx.openai.chat({
      messages: [
        {
          role: "system",
          content:
            "Generate a single creative portmanteau or variation that includes 'dank' anywhere in the word (beginning, middle, or end) and is contextually relevant to the recent conversation. Use the conversation context to make your variation more specific and less repetitive. Examples: dankalicious, danktacular, danktastic, superdank, megadank, dankified, radankulous. Respond with only the word, nothing else.",
        },
        {
          role: "user",
          content: `Recent conversation context:\n${contextText}\n\nGenerate a contextually relevant variation of 'dank' based on this conversation.`,
        },
      ],
    });

    await response.match(
      async (variation) => {
        await this.ctx.messenger
          .sendToChannel(message.channelId, variation.trim())
          .match(
            async () => undefined,
            async (error) => {
              this.ctx.logger.warn(
                { err: error },
                "Failed to send dank response",
              );
            },
          );
      },
      async (error) => {
        this.ctx.logger.warn(
          { err: error },
          "Failed to generate dank variation",
        );
      },
    );
  }
}
