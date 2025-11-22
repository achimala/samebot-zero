import type { MessageReaction, User, PartialMessageReaction, PartialUser } from "discord.js";
import { type Feature, type RuntimeContext } from "../core/runtime";

export class ReactionEchoFeature implements Feature {
  private ctx!: RuntimeContext;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.on("messageReactionAdd", (reaction, user) => {
      void this.handleReaction(reaction, user);
    });
  }

  private async handleReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    const fullUser = user.partial ? await user.fetch() : user;
    if (fullUser.bot) {
      return;
    }
    if (Math.random() > 0.25) {
      return;
    }
    try {
      const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
      const fetched = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;
      if (fetched.author?.id === this.ctx.discord.user?.id) {
        return;
      }
      await fetched.react(fullReaction.emoji);
    } catch (error) {
      this.ctx.logger.warn({ err: error }, "Failed to echo reaction");
    }
  }
}
