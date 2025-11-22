import { DateTime } from "luxon";
import { type Feature, type RuntimeContext } from "../core/runtime";

const ZONE = "America/Los_Angeles";

export class ImageOfDayFeature implements Feature {
  private ctx!: RuntimeContext;
  private timer: NodeJS.Timeout | null = null;

  register(context: RuntimeContext): void {
    this.ctx = context;
    context.discord.once("ready", () => {
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
    const today = DateTime.now().setZone(ZONE).toFormat("cccc, LLL dd");
    this.ctx.logger.info({ today }, "Running image of the day");
    const ideation = await this.ctx.openai.chat({
      messages: [
        {
          role: "system",
          content: "Create a JSON object with 'prompt' and 'caption' for a humorous meme referencing the given date."
        },
        {
          role: "user",
          content: `Date: ${today}. Keep caption under 120 characters.`
        }
      ]
    });

    await ideation.match(
      async (text) => {
        const { prompt, caption } = parsePromptResponse(text);
        const imageResult = await this.ctx.openai.generateImage({ prompt });
        await imageResult.match(
          async ({ buffer }) => {
            await this.ctx.messenger
              .sendBuffer(
                this.ctx.config.imageOfDayChannelId,
                buffer,
                "image-of-the-day.png",
                caption ?? prompt
              )
              .match(
                async () => undefined,
                async (error) => this.ctx.logger.error({ err: error }, "Failed to post image")
              );
            if (caption) {
              await this.ctx.messenger
                .sendToChannel(this.ctx.config.imageOfDayChannelId, caption)
                .match(
                  async () => undefined,
                  async (error) => this.ctx.logger.error({ err: error }, "Failed to post caption")
                );
            }
          },
          async (error) => {
            this.ctx.logger.error({ err: error }, "Image of the day failed to render");
          }
        );
      },
      async (error) => {
        this.ctx.logger.error({ err: error }, "Image of the day failed to ideate");
      }
    );

    this.scheduleNext();
  }
}

function parsePromptResponse(raw: string) {
  try {
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      const parsed = JSON.parse(raw.slice(jsonStart));
      return {
        prompt: parsed.prompt ?? raw,
        caption: parsed.caption ?? null
      };
    }
  } catch {
    // fallthrough
  }
  const promptMatch = raw.match(/prompt\s*[:=-]\s*(.+)/i);
  const captionMatch = raw.match(/caption\s*[:=-]\s*(.+)/i);
  return {
    prompt: promptMatch?.[1]?.trim() ?? raw.trim(),
    caption: captionMatch?.[1]?.trim() ?? null
  };
}
