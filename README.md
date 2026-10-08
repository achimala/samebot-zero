# Samebot Zero

A single-process TypeScript Discord bot. It keeps the fun conversational tone, emoji gimmicks, and meme-of-the-day posts.

## Models

| Job | Model |
|---|---|
| Conversation agent (tools, web search, vision) | Claude Sonnet 5.5 via the Anthropic SDK tool runner |
| Quick text jobs (emoji picks, names, brief replies) | Claude Haiku 5.5 |
| Creative prompt writing (scrapbook art, robot emoji) | Claude Sonnet 5.5 |
| Image of the day ideation | Claude Opus 5.5 |
| Yes/no and pick-one decisions (should reply, should react, scrapbook detection, aphorism check) | OpenAI Decisions API (`gpt-6-luna`) |
| Images | Gemini `gemini-3.1-flash-lite-image` (interactive), `gemini-nano-banana-2.1` (scheduled) |
| Video / GIFs | Gemini `gemini-omni-1.1-flash` |
| Long-term memory | Honcho |

LLM clients live in `src/llm/` (`claude.ts`, `decisions.ts`).

## Features

- **Conversation brain** – persona-aware replies for guild channels and DMs with smart mention/follow-up heuristics.
- **Slash utilities** – `/img` generates art with Gemini, `/debug` dumps the live context for the current channel.
- **Auto-react + reaction echo** – the Decisions API decides when to react, Claude picks the emoji.
- **Image of the day** – daily meme prompt + caption scheduled for 8am America/Los_Angeles sent to a configurable channel.
- **Single process** – Discord gateway, schedulers, and model access all run inside one Node process with strict typing and `neverthrow` results.

## Getting Started

1. **Install dependencies**
   ```bash
   pnpm install
   ```
2. **Configure environment** – copy `.env.example` to `.env` and fill in values:
   - `DISCORD_TOKEN`, `DISCORD_APP_ID`
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY` (Decisions API only)
   - `GOOGLE_API_KEY` (Gemini images/video)
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

- Source lives under `src/` grouped by domain (`core`, `discord`, `features`, `llm`, `memory`).
- All side effects use `neverthrow` results to avoid `try/catch`; see `src/llm/claude.ts` & `src/discord/messenger.ts` for patterns.
- Lint & tests:
  ```bash
  pnpm lint
  pnpm test   # Decisions tests hit the live API when OPENAI_API_KEY is set
  ```
