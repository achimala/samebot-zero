# Agent notes

## Debugging: check prod first

Samebot runs on Render, and most bug reports come from something that just happened in Discord. Before changing code for a bug, read the prod logs and find the actual error or behaviour.

`RENDER_API_KEY` is set in this environment. The bot is a background worker:

- Service id: `srv-d4gk1v95pdvs738l9160`
- Owner id (needed for logs): `tea-d4gjus95pdvs738l6vv0`

```sh
# Recent logs, newest first. Add &level=warn,error for problems only,
# or &startTime=/&endTime= (ISO 8601) to look around a specific time.
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/logs?ownerId=tea-d4gjus95pdvs738l6vv0&resource=srv-d4gk1v95pdvs738l9160&limit=100&direction=backward"

# Deploys, crashes and restarts (crash reason: oomKilled vs nonZeroExit)
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/srv-d4gk1v95pdvs738l9160/events?limit=20"
```

Each log line's `message` is a pino JSON record: `level` (30 info, 40 warn, 50 error), `msg`, and `err` with the message and stack. The logs show errors, tool calls and image prompts, but not the full text of chat messages.

Only read from the Render API. Don't change env vars, restart or redeploy the service.

## Shipping

`main` auto-deploys to prod. Work on a branch and open a PR; never push to `main` directly.

Before opening the PR, run `pnpm exec tsc --noEmit`, `pnpm lint` and `pnpm test --run`.
