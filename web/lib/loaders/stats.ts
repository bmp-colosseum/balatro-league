// Loader for /stats — league-wide fun stats that aggregate across the whole
// player base. Only confirmed pairings + non-DC games count.
//
// Performance: everything is aggregated at the DB level (groupBy with
// _count/_sum) — we never pull raw match rows into memory for the leaders,
// which kept the page at ~10s once the league had many seasons of data. The
// whole result is wrapped in unstable_cache with a short revalidate so repeat
// loads are instant and the heavy work runs at most once per window.

import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "@/lib/balatro-info";

export interface StatsLeaderRow {
  playerId: string;
  displayName: string;
  discordId: string;
  username: string | null;
  value: number;
}

// One row per deck / stake — play + ban numbers folded together so the page
// can show the full canonical list (every deck, every stake) in one table.
export interface StatsItemRow {
  name: string;
  gamesTotal: number;
  bansTotal: number;
  appearancesTotal: number; // pool appearances (ban-rate denominator)
  banRatePct: number; // bans ÷ appearances
}

export interface StatsComboRow {
  deck: string;
  stake: string;
  gamesTotal: number;
  // Share of all played games that used this combo (pick rate). Win rate is
  // meaningless league-wide — both players play the same combo each game — so
  // "most played" is ranked + shown by pick share, not a 50% win rate.
  sharePct: number;
  appearancesTotal: number;
  bansTotal: number;
  banRatePct: number;
}

export interface StatsStreakRow {
  playerId: string;
  displayName: string;
  discordId: string;
  username: string | null;
  streak: number;
  isActive: boolean;
}

export interface StatsPageData {
  topByMatchWins: StatsLeaderRow[];
  topByGameWins: StatsLeaderRow[];
  decks: StatsItemRow[];
  stakes: StatsItemRow[];
  mostPlayedCombos: StatsComboRow[];
  mostBannedCombos: StatsComboRow[];
  longestActiveStreaks: StatsStreakRow[];
}

// Min pool appearances before a combo's ban rate is trusted — drops 1-off
// flukes from dominating. (Per-deck/stake rows show their own sample size.)
const MIN_COMBO_APPEARANCES = 8;

// The league's "Standard" pool — only these decks/stakes are in ranked
// rotation, so stats show exactly them (not all 22 canonical decks). Falls back
// to the full canonical list if no standard preset is configured yet.
async function getStandardPool(): Promise<{ decks: string[]; stakes: string[] }> {
  const cfg = await prisma.leagueConfig.findFirst({
    where: { key: "season_default_preset_id" },
    select: { value: true },
  });
  if (cfg?.value) {
    const preset = await prisma.matchConfigPreset.findUnique({
      where: { id: cfg.value },
      select: { decks: true, stakes: true },
    });
    if (preset && (preset.decks.length > 0 || preset.stakes.length > 0)) {
      return { decks: preset.decks, stakes: preset.stakes };
    }
  }
  return { decks: CANONICAL_DECKS.map((d) => d.name), stakes: CANONICAL_STAKES.map((s) => s.name) };
}

// One row per deck/stake in the given pool, folding in play + ban aggregates.
// Rows for items never played yet still appear (so the full standard pool is
// always visible), sorted by games played.
function buildItemRows(
  poolNames: readonly string[],
  gameAgg: Map<string, { games: number }>,
  banAgg: Map<string, { appearances: number; bans: number }>,
): StatsItemRow[] {
  return [...new Set(poolNames)]
    .map((name) => {
      const g = gameAgg.get(name);
      const b = banAgg.get(name);
      const gamesTotal = g?.games ?? 0;
      const appearancesTotal = b?.appearances ?? 0;
      const bansTotal = b?.bans ?? 0;
      return {
        name,
        gamesTotal,
        appearancesTotal,
        bansTotal,
        banRatePct: appearancesTotal === 0 ? 0 : Math.round((bansTotal / appearancesTotal) * 100),
      };
    })
    .sort((a, b) => b.gamesTotal - a.gamesTotal || a.name.localeCompare(b.name));
}

async function computeStatsPageData(): Promise<StatsPageData> {
  const matchWhere = { status: "CONFIRMED" as const, format: "LEAGUE_BO2" as const };
  // deck not null excludes lives-only manual reports (no per-game deck/stake)
  // from the per-deck/stake/combo aggregates — they'd otherwise form a null
  // bucket. Manual rows have both deck and stake null, so this one guard covers
  // all three game-based aggregates below.
  const gameWhere = { dcByPlayerId: null, deck: { not: null }, match: { status: "CONFIRMED" as const } };
  const poolWhere = { game: { dcByPlayerId: null, match: { status: "CONFIRMED" as const } } };

  // ── Everything aggregated at the DB in one parallel batch ───────────
  const [
    // Match wins (a BO2 win is a 2-0, i.e. gamesWonX === 2) per side.
    winsAsA,
    winsAsB,
    // Game wins = sum of games taken per side.
    gamesAsA,
    gamesAsB,
    deckGameAgg,
    stakeGameAgg,
    deckBanAgg,
    stakeBanAgg,
    playedComboAgg,
    bannedComboAgg,
  ] = await Promise.all([
    prisma.match.groupBy({ by: ["playerAId"], where: { ...matchWhere, gamesWonA: 2 }, _count: { _all: true } }),
    prisma.match.groupBy({ by: ["playerBId"], where: { ...matchWhere, gamesWonB: 2 }, _count: { _all: true } }),
    prisma.match.groupBy({ by: ["playerAId"], where: matchWhere, _sum: { gamesWonA: true } }),
    prisma.match.groupBy({ by: ["playerBId"], where: matchWhere, _sum: { gamesWonB: true } }),
    prisma.game.groupBy({ by: ["deck"], where: gameWhere, _count: { _all: true } }),
    prisma.game.groupBy({ by: ["stake"], where: gameWhere, _count: { _all: true } }),
    prisma.gameDeck.groupBy({ by: ["deck"], where: poolWhere, _count: { _all: true, banOrdinal: true } }),
    prisma.gameDeck.groupBy({ by: ["stake"], where: poolWhere, _count: { _all: true, banOrdinal: true } }),
    prisma.game.groupBy({ by: ["deck", "stake"], where: gameWhere, _count: { _all: true } }),
    prisma.gameDeck.groupBy({ by: ["deck", "stake"], where: poolWhere, _count: { _all: true, banOrdinal: true } }),
  ]);

  // Fold the per-side aggregates into per-player totals.
  const matchWinsByPlayer = new Map<string, number>();
  for (const r of winsAsA) matchWinsByPlayer.set(r.playerAId, (matchWinsByPlayer.get(r.playerAId) ?? 0) + r._count._all);
  for (const r of winsAsB) matchWinsByPlayer.set(r.playerBId, (matchWinsByPlayer.get(r.playerBId) ?? 0) + r._count._all);
  const gameWinsByPlayer = new Map<string, number>();
  for (const r of gamesAsA) gameWinsByPlayer.set(r.playerAId, (gameWinsByPlayer.get(r.playerAId) ?? 0) + (r._sum.gamesWonA ?? 0));
  for (const r of gamesAsB) gameWinsByPlayer.set(r.playerBId, (gameWinsByPlayer.get(r.playerBId) ?? 0) + (r._sum.gamesWonB ?? 0));

  const topMatch = [...matchWinsByPlayer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topGames = [...gameWinsByPlayer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const leaderIds = new Set<string>([...topMatch.map((e) => e[0]), ...topGames.map((e) => e[0])]);
  const leaderNames = leaderIds.size === 0
    ? []
    : await prisma.player.findMany({ where: { id: { in: [...leaderIds] } }, select: { id: true, displayName: true, discordId: true, username: true } });
  const nameById = new Map(leaderNames.map((p) => [p.id, p.displayName]));
  const discordById = new Map(leaderNames.map((p) => [p.id, p.discordId]));
  const usernameById = new Map(leaderNames.map((p) => [p.id, p.username]));
  const toLeaderRow = ([playerId, value]: [string, number]): StatsLeaderRow => ({
    playerId,
    displayName: nameById.get(playerId) ?? "Unknown",
    discordId: discordById.get(playerId) ?? "",
    username: usernameById.get(playerId) ?? null,
    value,
  });
  const topByMatchWins = topMatch.map(toLeaderRow);
  const topByGameWins = topGames.map(toLeaderRow);

  // ── Per-deck / per-stake rows (full canonical list) ────────────────
  // gameWhere filters `deck: { not: null }`, so deck/stake are non-null here
  // (Prisma's groupBy result type still widens to `string | null`).
  const deckGameMap = new Map(deckGameAgg.map((r) => [r.deck!, { games: r._count._all }]));
  const stakeGameMap = new Map(stakeGameAgg.map((r) => [r.stake!, { games: r._count._all }]));
  const deckBanMap = new Map(deckBanAgg.map((r) => [r.deck, { appearances: r._count._all, bans: r._count.banOrdinal }]));
  const stakeBanMap = new Map(stakeBanAgg.map((r) => [r.stake, { appearances: r._count._all, bans: r._count.banOrdinal }]));
  const pool = await getStandardPool();
  const decks = buildItemRows(pool.decks, deckGameMap, deckBanMap);
  const stakes = buildItemRows(pool.stakes, stakeGameMap, stakeBanMap);

  // ── Combos (deck × stake) ──────────────────────────────────────────
  const totalComboGames = playedComboAgg.reduce((s, r) => s + r._count._all, 0);
  const mostPlayedCombos: StatsComboRow[] = playedComboAgg
    .map((r) => ({
      deck: r.deck!,
      stake: r.stake!,
      gamesTotal: r._count._all,
      sharePct: totalComboGames === 0 ? 0 : Math.round((r._count._all / totalComboGames) * 100),
      appearancesTotal: 0,
      bansTotal: 0,
      banRatePct: 0,
    }))
    .sort((a, b) => b.gamesTotal - a.gamesTotal)
    .slice(0, 8);
  const mostBannedCombos: StatsComboRow[] = bannedComboAgg
    .filter((r) => r._count._all >= MIN_COMBO_APPEARANCES)
    .map((r) => ({
      deck: r.deck,
      stake: r.stake,
      gamesTotal: 0,
      sharePct: 0,
      appearancesTotal: r._count._all,
      bansTotal: r._count.banOrdinal,
      banRatePct: r._count._all === 0 ? 0 : Math.round((r._count.banOrdinal / r._count._all) * 100),
    }))
    .sort((a, b) => b.banRatePct - a.banRatePct || b.bansTotal - a.bansTotal)
    .slice(0, 8);

  const longestActiveStreaks = await computeStreaks();

  return {
    topByMatchWins,
    topByGameWins,
    decks,
    stakes,
    mostPlayedCombos,
    mostBannedCombos,
    longestActiveStreaks,
  };
}

// Longest active win streaks: for each player in the active season, walk their
// confirmed pairings (across seasons) from most-recent backward, counting
// consecutive 2-0 wins. 2+ qualifies. Flags whether their last match was a win.
async function computeStreaks(): Promise<StatsStreakRow[]> {
  const activeSeason = await prisma.season.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!activeSeason) return [];
  const activeMembers = await prisma.divisionMember.findMany({
    where: { seasonId: activeSeason.id, status: "ACTIVE" },
    select: { playerId: true },
  });
  const activePlayerIds = [...new Set(activeMembers.map((m) => m.playerId))];
  if (activePlayerIds.length === 0) return [];

  const activeSet = new Set(activePlayerIds);
  const allPairings = await prisma.match.findMany({
    where: {
      status: "CONFIRMED",
      format: "LEAGUE_BO2",
      OR: [{ playerAId: { in: activePlayerIds } }, { playerBId: { in: activePlayerIds } }],
    },
    select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, confirmedAt: true },
    orderBy: { confirmedAt: "asc" },
  });
  const pairingsByPlayer = new Map<string, typeof allPairings>();
  for (const p of allPairings) {
    for (const pid of [p.playerAId, p.playerBId]) {
      if (!activeSet.has(pid)) continue;
      const arr = pairingsByPlayer.get(pid) ?? [];
      arr.push(p);
      pairingsByPlayer.set(pid, arr);
    }
  }
  const namesNeeded = await prisma.player.findMany({
    where: { id: { in: activePlayerIds } },
    select: { id: true, displayName: true, discordId: true, username: true },
  });
  const namesById = new Map(namesNeeded.map((p) => [p.id, p.displayName]));
  const discordById = new Map(namesNeeded.map((p) => [p.id, p.discordId]));
  const usernameById = new Map(namesNeeded.map((p) => [p.id, p.username]));
  const streaks: StatsStreakRow[] = [];
  for (const [playerId, list] of pairingsByPlayer) {
    let streak = 0;
    let activeStreak = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      const isA = p.playerAId === playerId;
      const myG = isA ? p.gamesWonA : p.gamesWonB;
      const oppG = isA ? p.gamesWonB : p.gamesWonA;
      if (myG > oppG) {
        if (i === list.length - 1) activeStreak = true;
        streak++;
      } else {
        break;
      }
    }
    if (streak >= 2) {
      streaks.push({ playerId, displayName: namesById.get(playerId) ?? "Unknown", discordId: discordById.get(playerId) ?? "", username: usernameById.get(playerId) ?? null, streak, isActive: activeStreak });
    }
  }
  return streaks.sort((a, b) => b.streak - a.streak).slice(0, 5);
}

// Cached so the heavy aggregation runs at most once per window, not per request.
export const loadStatsPageData = unstable_cache(computeStatsPageData, ["stats-page-data-v2"], {
  revalidate: 120,
  tags: ["stats"],
});
