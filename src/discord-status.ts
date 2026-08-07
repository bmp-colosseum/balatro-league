// Shell: external corroboration for bot-health.ts's "is Discord itself
// having an incident, or is this our own network/gateway having a bad day"
// question (see bot-health.ts's deriveAttribution). Polls Discord's public
// Statuspage API (https://discordstatus.com/api/v2/status.json -- no auth,
// documented Statuspage.io format) and caches the result.
//
// Cached at DISCORD_STATUS_CACHE_MS (~5min) because the health tick
// (bot-health.ts) runs every 60s -- polling their status API on every tick
// would be 5x more requests than the signal needs and is needless load on
// a third party during exactly the kind of incident we're asking about.
//
// NEVER throws. Any failure (network error, timeout, non-200, malformed
// JSON) resolves to null ("unknown") -- Discord's status page being
// unreachable must never affect our own health verdict, so every failure
// path is swallowed here, not surfaced to the caller as a rejection.

import type { DiscordStatusInfo } from "./bot-health.js";

const STATUS_URL = "https://discordstatus.com/api/v2/status.json";
const USER_AGENT = "BalatroLeagueBot/1.0 (+https://balatroleague.com)";
// Short on purpose -- this must never make the 60s health tick noticeably
// slower. A slow/unreachable status page degrades to "unknown", not a
// blocked tick.
const FETCH_TIMEOUT_MS = 2_500;
export const DISCORD_STATUS_CACHE_MS = 5 * 60_000;

interface StatuspageShape {
  status?: { indicator?: unknown; description?: unknown };
}

function isStatuspageShape(v: unknown): v is StatuspageShape {
  return typeof v === "object" && v !== null;
}

// PURE (no I/O) -- split out from fetchDiscordStatus for direct testing of
// the parse without needing to mock fetch.
export function parseStatuspageJson(json: string): DiscordStatusInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isStatuspageShape(parsed)) return null;
  const indicator = parsed.status?.indicator;
  const description = parsed.status?.description;
  if (typeof indicator !== "string" || typeof description !== "string") return null;
  return { indicator, description };
}

// -- Shell: cache -------------------------------------------------------

let cachedResult: DiscordStatusInfo | null = null;
let cachedAtMs: number | null = null;

// Test-only escape hatch so each test starts from a clean cache instead of
// leaking state across it/test cases.
export function __resetDiscordStatusCacheForTests(): void {
  cachedResult = null;
  cachedAtMs = null;
}

// Polls discordstatus.com at most once per DISCORD_STATUS_CACHE_MS. `nowMs`
// is injected (defaults to Date.now) so the cache window is testable
// without real timers. The cache timestamp is stamped BEFORE the await so a
// slow-then-failing fetch still respects the window on the next call --
// otherwise a hung/erroring endpoint would get hit on every single 60s tick
// instead of once per window.
export async function fetchDiscordStatus(nowMs: () => number = Date.now): Promise<DiscordStatusInfo | null> {
  const t = nowMs();
  if (cachedAtMs !== null && t - cachedAtMs < DISCORD_STATUS_CACHE_MS) {
    return cachedResult;
  }
  cachedAtMs = t;
  try {
    const res = await fetch(STATUS_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      cachedResult = null;
      return null;
    }
    const json = await res.text();
    cachedResult = parseStatuspageJson(json);
    return cachedResult;
  } catch (err) {
    console.warn("[discord-status] fetch failed (treating as unknown):", err);
    cachedResult = null;
    return null;
  }
}
