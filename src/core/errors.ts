export type BotError =
  | { type: "llm"; message: string }
  | { type: "gemini"; message: string }
  | { type: "discord"; message: string }
  | { type: "config"; message: string }
  | { type: "scheduler"; message: string };

export const Errors = {
  llm(message: string): BotError {
    return { type: "llm", message };
  },
  gemini(message: string): BotError {
    return { type: "gemini", message };
  },
  discord(message: string): BotError {
    return { type: "discord", message };
  },
  scheduler(message: string): BotError {
    return { type: "scheduler", message };
  },
};
