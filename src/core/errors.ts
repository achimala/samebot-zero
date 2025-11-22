export type BotError =
  | { type: "openai"; message: string }
  | { type: "discord"; message: string }
  | { type: "config"; message: string }
  | { type: "scheduler"; message: string };

export const Errors = {
  openai(message: string): BotError {
    return { type: "openai", message };
  },
  discord(message: string): BotError {
    return { type: "discord", message };
  },
  scheduler(message: string): BotError {
    return { type: "scheduler", message };
  },
};
