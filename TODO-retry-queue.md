# TODO: Discord-API retry queue / bucket-aware backoff

Pre-launch we get away with light retry handling; once we go live with many
concurrent matches + bootstrap operations, we need real rate-limit handling.

## Current state

- **Bot side (discord.js)**: handles rate limits + buckets transparently via
  the REST manager. No action needed.
- **Web side (raw fetch via `web/lib/discord.ts`)**: single 429 retry that
  honors Retry-After. No queueing, no bucket tracking, no concurrent-call
  throttling.

## Risk

The web bootstrap-divisions flow can fire dozens of REST calls in quick
succession (per division: 1 role create + N role-assigns + 1 channel create
+ permission overwrites + welcome ping). For a 19-division season with ~5
members each that's ~150+ requests in a few seconds. Discord's per-route
buckets (esp. `POST /guilds/{id}/roles`) cap at low single-digit req/sec.

## Proposed shape (when needed)

- Pull in `bottleneck` (~5kb, well-maintained) or write a tiny per-route
  limiter. Group requests by Discord route key (method + URL template).
- Bucket detection from response headers (`X-RateLimit-Bucket`,
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`).
- Exponential backoff with jitter on repeated 429s.
- Optional: persist failed-but-retryable jobs (e.g. add-role) to a DB queue
  so a deploy/crash doesn't drop work mid-bootstrap.

## What to do meanwhile

- Don't batch all 19 divisions in one click if it's a problem in practice;
  the bootstrap is idempotent so admins can re-run.
- The current single-retry-with-Retry-After is enough for occasional 429s.
