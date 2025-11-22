import type { MessageReaction, User } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

export class ReactionEchoFeature implements Feature {
  private ctx!: RuntimeContext;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.on("messageReactionAdd", (reaction, user) => {
      void this.handleReaction(reaction, user);
    });
  }

  private async handleReaction(reaction: MessageReaction, user: User) {
    if (user.bot) {
      return;
    }
    if (Math.random() > 0.25) {
      return;
    }
    try {
      const fetched = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      if (fetched.author?.id === this.ctx.discord.user?.id) {
        return;
      }
      await reaction.message.react(reaction.emoji);
    } catch (error) {
      this.ctx.logger.warn({ err: error }, "Failed to echo reaction");
    }
  }
}
