import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const ConfigSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_APP_ID: z.string().min(1, "DISCORD_APP_ID is required"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  CURSOR_API_KEY: z.string().min(1, "CURSOR_API_KEY is required"),
  SUPABASE_URL: z.string().min(1, "SUPABASE_URL is required"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SUPABASE_DB_CONNECTION_URI: z
    .string()
    .min(1, "SUPABASE_DB_CONNECTION_URI is required"),
  HONCHO_URL: z.string().url("HONCHO_URL must be a valid URL"),
  HONCHO_API_KEY: z.string().min(1, "HONCHO_API_KEY is required"),
  HONCHO_WORKSPACE_ID: z
    .string()
    .min(1, "HONCHO_WORKSPACE_ID is required"),
  HONCHO_ASSISTANT_PEER_ID: z
    .string()
    .min(1, "HONCHO_ASSISTANT_PEER_ID is required"),
  MAIN_CHANNEL_ID: z.string().min(1, "MAIN_CHANNEL_ID is required"),
  IMAGE_OF_DAY_CHANNEL_ID: z.string().optional(),
  EMOJI_GUILD_ID: z.string().min(1, "EMOJI_GUILD_ID is required"),
  MAIN_GUILD_ID: z.string().min(1, "MAIN_GUILD_ID is required"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),
});

export type AppConfig = {
  discordToken: string;
  discordAppId: string;
  openAIApiKey: string;
  cursorApiKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseDbConnectionUri: string;
  honchoUrl: string;
  honchoApiKey: string;
  honchoWorkspaceId: string;
  honchoAssistantPeerId: string;
  mainChannelId: string;
  imageOfDayChannelId: string;
  emojiGuildId: string;
  mainGuildId: string;
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
    cursorApiKey: env.CURSOR_API_KEY,
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseDbConnectionUri: env.SUPABASE_DB_CONNECTION_URI,
    honchoUrl: env.HONCHO_URL,
    honchoApiKey: env.HONCHO_API_KEY,
    honchoWorkspaceId: env.HONCHO_WORKSPACE_ID,
    honchoAssistantPeerId: env.HONCHO_ASSISTANT_PEER_ID,
    mainChannelId: env.MAIN_CHANNEL_ID,
    imageOfDayChannelId: env.IMAGE_OF_DAY_CHANNEL_ID ?? env.MAIN_CHANNEL_ID,
    emojiGuildId: env.EMOJI_GUILD_ID,
    mainGuildId: env.MAIN_GUILD_ID,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
