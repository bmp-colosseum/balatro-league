// Pipe discord.js REST events into the bot's console so we can see when
// we hit rate limits, how often, and what got throttled. Pure observability
// — discord.js's REST manager already handles backoff/retry; we just want
// a paper trail when something feels slow.
//
// Three signals captured:
//   RateLimited: a bucket has filled, request is queued (or dropped). The
//     interesting fields are method/url/retryAfter so we can correlate
//     with user-visible slowness.
//   InvalidRequestWarning: count of 401/403/429 in the recent window;
//     Discord temporarily bans the bot if this exceeds 10k in 10 minutes,
//     so worth catching early.
//   Response 429: an actual rate-limited response slipped through (rare;
//     means discord.js's preemptive throttling didn't catch it).

import { RESTEvents, type RateLimitData, type InvalidRequestWarningData, type RestEvents } from "@discordjs/rest";
import type { Client } from "discord.js";

export function attachRateLimitLogging(client: Client): void {
  const rest = client.rest;

  rest.on(RESTEvents.RateLimited, (info: RateLimitData) => {
    console.warn("[rate-limit] hit:", {
      method: info.method,
      url: info.url,
      route: info.route,
      hash: info.hash,
      retryAfter: info.retryAfter,
      timeToReset: info.timeToReset,
      majorParameter: info.majorParameter,
      global: info.global,
    });
  });

  rest.on(RESTEvents.InvalidRequestWarning, (info: InvalidRequestWarningData) => {
    // Discord soft-bans bots that accumulate >10000 invalid requests in
    // 10 minutes. Logging early gives us a chance to investigate before
    // the bot gets locked out.
    console.warn("[rate-limit] invalid-request count:", info.count, "remaining-ms:", info.remainingTime);
  });

  rest.on(RESTEvents.Response, (req: RestEvents["response"][0], res: RestEvents["response"][1]) => {
    if (res.status !== 429) return;
    console.error("[rate-limit] 429 response:", {
      method: req.method,
      path: req.path,
      retryAfter: res.headers.get("retry-after"),
      bucket: res.headers.get("x-ratelimit-bucket"),
      global: res.headers.get("x-ratelimit-global"),
      scope: res.headers.get("x-ratelimit-scope"),
    });
  });
}
