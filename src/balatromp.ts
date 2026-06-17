// Fetch per-player Ranked stats from balatromp.com via their tRPC API.
//
// They don't advertise an API, but the site is a Next.js + tRPC app and
// their procedures are reachable directly over HTTP — same endpoints the
// page uses to hydrate its own React Query cache. Returns clean JSON
// instead of forcing us to scrape rendered HTML, which means we get an
// immediate error if the contract changes (not silent parse failure).
//
// We only call leaderboard.get_user_rank for channel_id "1" (Ranked).
// channel_id 2/4/7 are smaller modes (Smallworld, Legacy, …) — the
// league cares about Ranked for seeding.

const TRPC_URL = "https://balatromp.com/api/trpc/leaderboard.get_user_rank";
const USER_AGENT = "BalatroLeagueBot/1.0 (+https://balatroleague.com)";
const FETCH_TIMEOUT_MS = 10_000;
const RANKED_CHANNEL_ID = "1";

export interface BalatropStats {
  rankedMmr: number;
  rankedTier: string;
  totalGames: number;
  winRatePct: number;
  // Direct fields off the tRPC response — surfaced on profile pages so
  // players can see peak, raw W/L, longest streak, leaderboard rank.
  peakMmr: number | null;
  wins: number | null;
  losses: number | null;
  peakStreak: number | null;
  leaderboardRank: number | null;
}

export interface FetchResult {
  stats: BalatropStats | null;
  rawJson: string;
  error: string | null;
}

// Definitive "this player has no Ranked record for this query" — distinct from
// a transient HTTP/timeout failure. For a FROZEN past season this answer never
// changes, so callers can record it once and stop re-fetching. (HTTP/timeout
// errors, by contrast, are worth retrying.)
export const NO_RANKED_RECORD = "No Ranked record for this player";

// season: BMP-season tag like "season6" to query historical data. Null/
// omitted = current state for the active season. Confirmed the tRPC
// endpoint accepts a `season` field in the input object.
export async function fetchPlayerStats(
  discordId: string,
  season: string | null = null,
): Promise<FetchResult> {
  const inputObj: Record<string, unknown> = {
    channel_id: RANKED_CHANNEL_ID,
    user_id: discordId,
  };
  if (season) inputObj.season = season;
  const input = encodeURIComponent(JSON.stringify({ json: inputObj }));
  const url = `${TRPC_URL}?input=${input}`;
  let rawJson = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { stats: null, rawJson: "", error: `HTTP ${res.status}` };
    }
    rawJson = await res.text();
    return parseRankedResponse(rawJson);
  } catch (err) {
    return {
      stats: null,
      rawJson,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Exported for testability + re-parse if the response shape ever shifts.
export function parseRankedResponse(json: string): FetchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { stats: null, rawJson: json, error: "Response was not JSON" };
  }
  // Shape: {result: {data: {json: {data: <record> | null, isStale}}}}
  const record = (parsed as { result?: { data?: { json?: { data?: RankedRecord | null } } } })
    ?.result?.data?.json?.data;
  if (record == null) {
    // No ranked record for this discord id — player exists in some other
    // channel, or doesn't exist at all. Same outcome: no MMR to capture.
    return { stats: null, rawJson: json, error: NO_RANKED_RECORD };
  }
  if (typeof record.mmr !== "number" || typeof record.totalgames !== "number") {
    return { stats: null, rawJson: json, error: "Response missing expected fields" };
  }
  return {
    stats: {
      rankedMmr: Math.round(record.mmr),
      rankedTier: mmrToTier(record.mmr),
      totalGames: record.totalgames,
      winRatePct: Math.round((record.winrate ?? 0) * 100),
      peakMmr: typeof record.peak_mmr === "number" ? Math.round(record.peak_mmr) : null,
      wins: typeof record.wins === "number" ? record.wins : null,
      losses: typeof record.losses === "number" ? record.losses : null,
      peakStreak: typeof record.peak_streak === "number" ? record.peak_streak : null,
      leaderboardRank: typeof record.rank === "number" ? record.rank : null,
    },
    rawJson: json,
    error: null,
  };
}

interface RankedRecord {
  mmr: number;
  totalgames: number;
  winrate: number;
  wins?: number;
  losses?: number;
  rank?: number;
  peak_mmr?: number;
  peak_streak?: number;
}

// Auto-detect the currently-active BMP season by scraping the leaderboards
// page, which renders a season picker with every season as an option. The
// highest seasonN value is the current. Returns null if the page is
// unreachable or no seasons are found (defensive — caller can fall back
// to a previously-stored LeagueConfig value).
export async function detectCurrentBmpSeason(): Promise<string | null> {
  try {
    const res = await fetch("https://balatromp.com/leaderboards", {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    let maxN = 0;
    for (const m of html.matchAll(/season(\d+)/gi)) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
    return maxN > 0 ? `season${maxN}` : null;
  } catch {
    return null;
  }
}

// Threshold-based Balatro MP tiers. Higher tiers (Foil top-50, Holographic
// top-10, Polychrome top-5, Negative top-1) are placement-based, not MMR
// thresholds — we don't compute those here; high-MMR players just read
// "Glass" and that's fine for seeding purposes.
function mmrToTier(mmr: number): string {
  if (mmr < 250) return "Stone";
  if (mmr < 320) return "Steel";
  if (mmr < 460) return "Gold";
  if (mmr < 620) return "Lucky";
  return "Glass";
}
