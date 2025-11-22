# Samebot Zero

A modern, single-process TypeScript rewrite of Samebot Neue. It keeps the fun conversational tone, emoji gimmicks, and meme-of-the-day posts while relying only on Discord + OpenAI (`gpt-5.1` with `web_search` and `gpt-image-1`).

## Features

- **Conversation brain** – persona-aware replies for guild channels and DMs with smart mention/follow-up heuristics.
- **Slash utilities** – `/img` generates art with Google’s Nano Banana Pro (`gemini-3-pro-image-preview`), `/debug` dumps the live context for the current channel.
- **Auto-react + reaction echo** – lightweight emoji reactions powered by GPT and a Swift-style +1 port.
- **Image of the day** – daily meme prompt + caption scheduled for 8am America/Los_Angeles sent to a configurable channel.
- **Zero microservices** – Discord gateway, schedulers, and OpenAI access all run inside one Node process with strict typing and `neverthrow` results.

## Getting Started

1. **Install dependencies**
   ```bash
   pnpm install
   ```
2. **Configure environment** – copy `.env.example` to `.env` and fill in values:
   - `DISCORD_TOKEN`, `DISCORD_APP_ID`
   - `OPENAI_API_KEY`
   - `GOOGLE_API_KEY` (Google AI Studio key for Nano Banana Pro)
   - `MAIN_CHANNEL_ID` (bot's home channel)
   - `IMAGE_OF_DAY_CHANNEL_ID` (defaults to `MAIN_CHANNEL_ID` if omitted)
3. **Run locally**
   ```bash
   pnpm dev
   ```
   The bot registers slash commands on startup and begins processing events.
4. **Build for production**
   ```bash
   pnpm build
   pnpm start
   ```

## Development Notes

- Source lives under `src/` grouped by domain (`core`, `discord`, `features`, `openai`).
- All side effects use `neverthrow` results to avoid `try/catch`; see `src/openai/client.ts` & `src/discord/messenger.ts` for patterns.
- Lint & tests:
  ```bash
  pnpm lint
  pnpm test
  ```

## Next Steps

- Reintroduce long-term memory or tasks as future modules.
- Expand heuristics for `web_search` tool usage once requirements solidify.
- Add integration tests that mock Discord/OpenAI via `vitest` + `msw` if needed.
