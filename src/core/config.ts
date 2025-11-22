import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const ConfigSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_APP_ID: z.string().min(1, "DISCORD_APP_ID is required"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  GOOGLE_API_KEY: z.string().min(1, "GOOGLE_API_KEY is required"),
  CURSOR_API_KEY: z.string().min(1, "CURSOR_API_KEY is required"),
  SUPABASE_URL: z.string().min(1, "SUPABASE_URL is required"),
  SUPABASE_ANON_KEY: z.string().min(1, "SUPABASE_ANON_KEY is required"),
  MAIN_CHANNEL_ID: z.string().min(1, "MAIN_CHANNEL_ID is required"),
  IMAGE_OF_DAY_CHANNEL_ID: z.string().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),
});

export type AppConfig = {
  discordToken: string;
  discordAppId: string;
  openAIApiKey: string;
  googleApiKey: string;
  cursorApiKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  mainChannelId: string;
  imageOfDayChannelId: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
};

export function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((err: z.ZodIssue) => `${err.path.join(".")}: ${err.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${formatted}`);
  }

  const env = parsed.data;
  return {
    discordToken: env.DISCORD_TOKEN,
    discordAppId: env.DISCORD_APP_ID,
    openAIApiKey: env.OPENAI_API_KEY,
    googleApiKey: env.GOOGLE_API_KEY,
    cursorApiKey: env.CURSOR_API_KEY,
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    mainChannelId: env.MAIN_CHANNEL_ID,
    imageOfDayChannelId: env.IMAGE_OF_DAY_CHANNEL_ID ?? env.MAIN_CHANNEL_ID,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
