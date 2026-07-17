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

import {
  RESTEvents,
  type InternalRequest,
  type InvalidRequestWarningData,
  type RateLimitData,
  type REST,
  type RestEvents,
} from "@discordjs/rest";
import type { Client } from "discord.js";
import { discordRestDurationSeconds, discordRestRequestsTotal, normalizeRestRoute } from "./metrics.js";

// Pull an HTTP status off a rejected REST call -- DiscordAPIError and
// HTTPError both carry a numeric .status; anything else labels "error".
function restErrorStatus(err: unknown): string {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") return String(status);
  }
  return "error";
}

// Time every REST request into Prometheus. request() is replaced with a
// wrapper that hangs sync observes off the promise the call already returns
// -- no added awaits, same signature, same resolution/rejection. request()
// resolves with the parsed body (not the Response), so successes are
// labeled status="ok"; failures use the error's HTTP status when present.
// Exported for the standalone REST instances (announce.ts, balatro-emojis.ts)
// that don't go through client.rest; WeakSet guards double-wrapping.
const instrumented = new WeakSet<REST>();

export function attachRestTiming(rest: REST): void {
  if (instrumented.has(rest)) return;
  instrumented.add(rest);
  const original = rest.request.bind(rest);
  const wrapped: typeof rest.request = (options: InternalRequest) => {
    const method = options.method;
    const route = normalizeRestRoute(options.fullRoute);
    const start = Date.now();
    const record = (status: string) => {
      discordRestDurationSeconds.observe({ method, route }, (Date.now() - start) / 1000);
      discordRestRequestsTotal.inc({ method, route, status });
    };
    return original(options).then(
      (result) => {
        record("ok");
        return result;
      },
      (err: unknown) => {
        record(restErrorStatus(err));
        throw err;
      },
    );
  };
  rest.request = wrapped;
}

export function attachRateLimitLogging(client: Client): void {
  const rest = client.rest;
  attachRestTiming(rest);

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
