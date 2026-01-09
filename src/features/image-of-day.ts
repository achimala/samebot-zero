import { DateTime } from "luxon";
import { z } from "zod";
import { type Feature, type RuntimeContext } from "../core/runtime";
import { EntityResolver } from "../utils/entity-resolver";

const ZONE = "America/Los_Angeles";

const PromptResponseSchema = z.object({
  prompt: z.string().optional(),
  caption: z.string().optional(),
});

const promptResponseJsonSchema = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    caption: { type: "string" },
  },
  required: ["prompt", "caption"],
  additionalProperties: false,
};

export class ImageOfDayFeature implements Feature {
  private ctx!: RuntimeContext;
  private timer: NodeJS.Timeout | null = null;
  private entityResolver!: EntityResolver;

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.entityResolver = new EntityResolver(context.supabase, context.logger);
    if (context.discord.isReady()) {
      this.scheduleNext();
    }
    context.discord.on("ready", () => {
      this.scheduleNext();
    });
  }

  private scheduleNext() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const delay = this.msUntilNextRun();
    this.ctx.logger.info({ delayMs: delay }, "Scheduled next image of the day");
    this.timer = setTimeout(() => {
      void this.runJob();
    }, delay);
  }

  private msUntilNextRun() {
    const now = DateTime.now().setZone(ZONE);
    let target = now.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
    if (target <= now) {
      target = target.plus({ days: 1 });
    }
    return Math.max(1, target.toMillis() - now.toMillis());
  }

  private async runJob() {
    try {
      const today = DateTime.now().setZone(ZONE).toFormat("cccc, LLL dd");
      this.ctx.logger.info({ today }, "Running image of the day");

      const availableEntities = await this.ctx.supabase.listEntityFolders();
      const entityContext =
        availableEntities.length > 0
          ? `\n\nYou can feature these people/entities in your meme (we have reference images for them): ${availableEntities.join(", ")}. Feel free to include them by name in your prompt if it would make the meme funnier. Note: These reference images are used as references for generation, not as images to be directly pasted into the output.`
          : "";

      let conversationContext = "";
      let hasLittleConversation = true;
      if (this.ctx.conversation) {
        const context = this.ctx.conversation.getContext(
          this.ctx.config.imageOfDayChannelId,
        );
        if (context && context.history.length > 2) {
          conversationContext = `\n\nRecent conversation context (use this for inspiration or references):\n${this.ctx.conversation.formatContext(context)}`;
          hasLittleConversation = false;
        }
      }

      const systemPrompt = hasLittleConversation
        ? `Create a JSON object with 'prompt' and 'caption' for a fun, creative meme or story. Since there's little recent conversation, feel free to make up something entertaining and humorous - it could be a random funny scenario, a silly story, or an absurd meme. Be creative!${entityContext}`
        : `Create a JSON object with 'prompt' and 'caption' for a humorous meme referencing the given date.${entityContext}${conversationContext}`;

      const userPrompt = hasLittleConversation
        ? `Date: ${today}. Create something fun and entertaining - make up your own funny meme or story! Keep caption under 120 characters.`
        : `Date: ${today}. Keep caption under 120 characters.`;

      const ideation = await this.ctx.openai.chatStructured<
        z.infer<typeof PromptResponseSchema>
      >({
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        schema: promptResponseJsonSchema,
        schemaName: "prompt_response",
        schemaDescription:
          "A prompt and optional caption for generating a humorous meme image",
      });

      await ideation.match(
        async (data) => {
          const validated = PromptResponseSchema.safeParse(data);
          if (!validated.success) {
            this.ctx.logger.error(
              { err: validated.error },
              "Invalid structured output",
            );
            return;
          }
          const { prompt, caption } = validated.data;
          if (!prompt) {
            this.ctx.logger.error("No prompt in structured output");
            return;
          }

          let effectivePrompt = prompt;
          let referenceImages:
            | Array<{ data: string; mimeType: string }>
            | undefined;

          const resolution = await this.entityResolver.resolve(prompt);
          if (resolution) {
            const built =
              this.entityResolver.buildPromptWithReferences(resolution);
            effectivePrompt = built.textPrompt;
            referenceImages = built.referenceImages;
          }

          const imageOptions: Parameters<
            typeof this.ctx.openai.generateImage
          >[0] = {
            prompt: effectivePrompt,
          };
          if (referenceImages) {
            imageOptions.referenceImages = referenceImages;
          }
          const imageResult = await this.ctx.openai.generateImage(imageOptions);
          await imageResult.match(
            async ({ buffer }) => {
              await this.ctx.messenger
                .sendBuffer(
                  this.ctx.config.imageOfDayChannelId,
                  buffer,
                  "image-of-the-day.png",
                  caption || prompt,
                )
                .match(
                  async () => undefined,
                  async (error) =>
                    this.ctx.logger.error(
                      { err: error },
                      "Failed to post image",
                    ),
                );
              if (caption) {
                await this.ctx.messenger
                  .sendToChannel(this.ctx.config.imageOfDayChannelId, caption)
                  .match(
                    async () => undefined,
                    async (error) =>
                      this.ctx.logger.error(
                        { err: error },
                        "Failed to post caption",
                      ),
                  );
              }
            },
            async (error) => {
              this.ctx.logger.error(
                { err: error },
                "Image of the day failed to render",
              );
            },
          );
        },
        async (error) => {
          this.ctx.logger.error(
            { err: error },
            "Image of the day failed to ideate",
          );
        },
      );
    } catch (error) {
      this.ctx.logger.error(
        { err: error },
        "Unexpected error in image of the day job",
      );
    } finally {
      this.scheduleNext();
    }
  }
}
