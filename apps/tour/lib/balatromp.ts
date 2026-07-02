// Read-only port of the league's balatromp.com fetcher (src/balatromp.ts) — per-player
// Ranked stats via their tRPC endpoint, keyed by DISCORD ID. Used to auto-pull a signup's
// rank/MMR (no more asking for a BMP handle) and to enrich the draft pool. Best-effort:
// callers must treat null stats as "unknown", never as an error to the user.
const TRPC_URL = "https://balatromp.com/api/trpc/leaderboard.get_user_rank";
const USER_AGENT = "PizzaPowerTour/1.0 (+https://tour.balatroleague.com)";
const FETCH_TIMEOUT_MS = 8_000;
const RANKED_CHANNEL_ID = "1";

export interface BmpStats {
  rankedMmr: number;
  rankedTier: string;
  totalGames: number;
  winRatePct: number;
  peakMmr: number | null;
  leaderboardRank: number | null;
}

interface RankedRecord {
  mmr: number;
  totalgames: number;
  winrate: number;
  rank?: number;
  peak_mmr?: number;
}

// Fetch a player's current Ranked stats by Discord id. Returns null on ANY failure
// (no record, HTTP error, timeout) — signup flow proceeds without it.
export async function fetchBmpStats(discordId: string): Promise<BmpStats | null> {
  try {
    const input = encodeURIComponent(JSON.stringify({ json: { channel_id: RANKED_CHANNEL_ID, user_id: discordId } }));
    const res = await fetch(`${TRPC_URL}?input=${input}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { result?: { data?: { json?: { data?: RankedRecord | null } } } };
    const record = parsed?.result?.data?.json?.data;
    if (record == null || typeof record.mmr !== "number" || typeof record.totalgames !== "number") return null;
    return {
      rankedMmr: Math.round(record.mmr),
      rankedTier: mmrToTier(record.mmr),
      totalGames: record.totalgames,
      winRatePct: Math.round((record.winrate ?? 0) * 100),
      peakMmr: typeof record.peak_mmr === "number" ? Math.round(record.peak_mmr) : null,
      leaderboardRank: typeof record.rank === "number" ? record.rank : null,
    };
  } catch {
    return null;
  }
}

// Threshold-based BMP tiers (placement tiers above Glass are not computed here).
export function mmrToTier(mmr: number): string {
  if (mmr < 250) return "Stone";
  if (mmr < 320) return "Steel";
  if (mmr < 460) return "Gold";
  if (mmr < 620) return "Lucky";
  return "Glass";
}
