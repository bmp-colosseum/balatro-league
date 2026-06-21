// Balatro MP (BMP) MMR snapshotting — capture a player's public ranked stats
// from balatromp.com into PlayerMmrSnapshot rows. Pulled out of queue.ts: the
// pg-boss workers (snapshot.mmr, refresh.active-mmrs) in queue.ts call these,
// but the logic itself is pure DB + balatromp scraping with no queue concerns.

import { detectCurrentBmpSeason, fetchPlayerStats, NO_RANKED_RECORD } from "./balatromp.js";
import { prisma } from "./db.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";

export interface MmrSnapshotJob {
  // Canonical key — works even when no Player row exists yet (new signups
  // captured at signup-close, before build-season materializes Players).
  discordId: string;
  // Null = ad-hoc capture not tied to a season (admin refresh of a player).
  seasonId: string | null;
}

export async function snapshotPlayerMmr({ discordId, seasonId }: MmrSnapshotJob): Promise<void> {
  const player = await prisma.player.findUnique({ where: { discordId } });
  // Resolve the BMP current-season tag from LeagueConfig. Auto-detected
  // on bot startup + daily refresh; admin can also override manually.
  const currentBmpSeason = await getConfig(LeagueConfigKey.BmpCurrentSeason);
  // Capture the current state — unless we resolved it for this player recently.
  // A signup-MMR re-click (or overlapping enqueues) shouldn't re-hit the
  // rate-limited balatromp API; the daily refresh runs 24h apart, well outside
  // this window, so it still updates.
  //
  // "Resolved" means a DEFINITIVE answer within the window: a captured MMR OR a
  // confirmed "no ranked record yet" (NO_RANKED_RECORD). The current season is
  // live, so "no record" is only temporary — the player could start playing —
  // so we throttle it to the same window (don't hammer the API every job for
  // someone with nothing to fetch) but NEVER mark them permanently skipped: the
  // window reopens and they get rechecked. Transient HTTP/timeout rows are not
  // "resolved", so those retry promptly.
  const FRESHNESS_MS = 6 * 60 * 60 * 1000; // 6h
  const recentlyResolved = currentBmpSeason
    ? await prisma.playerMmrSnapshot.findFirst({
        where: {
          discordId,
          bmpSeason: currentBmpSeason,
          OR: [{ fetchError: null }, { fetchError: NO_RANKED_RECORD }],
          capturedAt: { gte: new Date(Date.now() - FRESHNESS_MS) },
        },
        select: { id: true },
      })
    : null;
  if (recentlyResolved) {
    console.log(`[snapshot.mmr] ${discordId} — current (${currentBmpSeason}) checked <6h ago, skipping`);
  } else {
    await fetchAndStore(discordId, player?.id ?? null, seasonId, currentBmpSeason);
  }

  if (!currentBmpSeason) return;
  const prev = previousBmpSeason(currentBmpSeason);
  if (!prev) return;

  // Also capture the PREVIOUS BMP season — enough for the "hasn't played the
  // current season, fall back to their last one" case (the signup MMR view +
  // the profile's last-2-seasons trend). We deliberately do NOT backfill ALL of
  // history (season1…current-1) anymore: that turned a single signup-MMR
  // refresh into ~N fetches PER player, which buried the rate-limited
  // snapshot.mmr queue and tripped the stall alert.
  //
  // A past season is FROZEN, so we only ever need ONE definitive answer per
  // player: either we captured their ranked row, OR balatromp confirmed they
  // have no record for it (NO_RANKED_RECORD) — that "no record" is permanent
  // too, so a player who didn't play last season must NOT be re-fetched every
  // job forever. We DO retry rows that exist only because the fetch failed
  // transiently (HTTP/timeout), and the force-recapture flag overrides all of
  // this to overwrite briefly-bad API data.
  const forceRecapture = (await getConfig(LeagueConfigKey.BmpCapturePreviousSeason)) === "true";
  if (!forceRecapture) {
    const haveDefinitive = await prisma.playerMmrSnapshot.findFirst({
      where: {
        discordId,
        bmpSeason: prev,
        OR: [{ fetchError: null }, { fetchError: NO_RANKED_RECORD }],
      },
      select: { id: true },
    });
    if (haveDefinitive) return;
  }
  await fetchAndStore(discordId, player?.id ?? null, seasonId, prev);
}

// Single fetch + insert. Splitting out so snapshotPlayerMmr can call it
// twice (current + previous BMP season) without duplicating the wiring.
async function fetchAndStore(
  discordId: string,
  playerId: string | null,
  seasonId: string | null,
  bmpSeason: string | null,
): Promise<void> {
  const { stats, rawJson, error } = await fetchPlayerStats(discordId, bmpSeason);
  const label = bmpSeason ?? "current";
  if (!error) {
    console.log(`[snapshot.mmr] ${discordId} (${label}) → mmr=${stats?.rankedMmr ?? "—"} tier=${stats?.rankedTier ?? "—"}`);
  } else if (error === NO_RANKED_RECORD) {
    // Not a failure — the player simply has no Ranked row for this query
    // (hasn't played that season). Still recorded (so the skip checks see a
    // definitive answer), but logged as info, not an error.
    console.log(`[snapshot.mmr] ${discordId} (${label}) — no ranked record yet`);
  } else {
    console.warn(`[snapshot.mmr] ${discordId} (${label}) fetch failed: ${error}`);
  }
  await prisma.playerMmrSnapshot.create({
    data: {
      discordId,
      playerId,
      seasonId,
      bmpSeason,
      rankedMmr: stats?.rankedMmr ?? null,
      rankedTier: stats?.rankedTier ?? null,
      totalGames: stats?.totalGames ?? null,
      winRatePct: stats?.winRatePct ?? null,
      peakMmr: stats?.peakMmr ?? null,
      wins: stats?.wins ?? null,
      losses: stats?.losses ?? null,
      peakStreak: stats?.peakStreak ?? null,
      leaderboardRank: stats?.leaderboardRank ?? null,
      // Only keep the blob on genuine failures (to debug a parse/HTTP issue) —
      // a success or a benign "no record" doesn't need a JSON body per player
      // taking up space.
      rawHtml: error && error !== NO_RANKED_RECORD ? rawJson : null,
      fetchError: error,
    },
  });
}

// Detect BMP's current season from their leaderboards page and update
// LeagueConfig.BmpCurrentSeason if it changed. Best-effort — failures
// leave the existing config alone. Called at bot boot + at the start
// of each daily refresh cron so per-player snapshots always use the
// latest 'current' season label without admin intervention.
export async function ensureBmpCurrentSeasonDetected(): Promise<void> {
  const detected = await detectCurrentBmpSeason();
  if (!detected) return;
  const stored = await getConfig(LeagueConfigKey.BmpCurrentSeason);
  if (stored === detected) return;
  await setConfig(LeagueConfigKey.BmpCurrentSeason, detected, "auto-detect");
  console.log(`[bmp] current season ${stored ? `updated ${stored} → ${detected}` : `set to ${detected}`}`);
}

// "season6" → "season5". Returns null if input isn't a recognized
// season pattern or if there's no previous (season1 → null).
function previousBmpSeason(s: string): string | null {
  const m = /^season(\d+)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 1) return null;
  return `season${n - 1}`;
}
