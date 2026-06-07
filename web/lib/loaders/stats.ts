// Loader for /stats — league-wide fun stats that aggregate across the
// whole player base. Only confirmed pairings + non-DC games count.
// Most queries are JS-side aggregation over a small N (one query per
// table, fold in memory) since the dataset is bounded by player count.

import { prisma } from "@/lib/prisma";

export interface StatsLeaderRow {
  playerId: string;
  displayName: string;
  value: number;
}

export interface StatsDeckRow {
  name: string;
  gamesTotal: number;
  gamesWon: number;
  winRatePct: number;
}

export interface StatsBanRow {
  name: string;
  // Total times this deck/stake was banned across all confirmed games.
  bansTotal: number;
  // How often this deck/stake appeared in a game's pool (sample size).
  appearancesTotal: number;
  // bans / appearances — "when this shows up, how often is it banned?"
  banRatePct: number;
}

export interface StatsStreakRow {
  playerId: string;
  displayName: string;
  streak: number;
  isActive: boolean;
}

export interface StatsPageData {
  topByRating: StatsLeaderRow[];
  topByMatchWins: StatsLeaderRow[];
  topByGameWins: StatsLeaderRow[];
  mostPlayedDecks: StatsDeckRow[];
  bestDecks: StatsDeckRow[];
  worstDecks: StatsDeckRow[];
  mostPlayedStakes: StatsDeckRow[];
  bestStakes: StatsDeckRow[];
  worstStakes: StatsDeckRow[];
  mostBannedDecks: StatsBanRow[];
  mostBannedStakes: StatsBanRow[];
  longestActiveStreaks: StatsStreakRow[];
}

// Minimum games threshold for "best/worst" deck/stake lists so a 1-game
// freak result doesn't dominate the leaderboard.
const MIN_GAMES_FOR_RANKING = 20;

export async function loadStatsPageData(): Promise<StatsPageData> {
  // ── Player leaders ──────────────────────────────────────────────────
  // Top by global rank (rating ASC, 1 = best).
  const topRated = await prisma.player.findMany({
    where: { rating: { not: null } },
    orderBy: { rating: "asc" },
    take: 5,
    select: { id: true, displayName: true, rating: true },
  });
  const topByRating: StatsLeaderRow[] = topRated.map((p) => ({
    playerId: p.id,
    displayName: p.displayName,
    value: p.rating ?? 0,
  }));

  // Top by career match wins (2-0 results across all CONFIRMED pairings).
  // Pairing rows + group-by-player. Two passes since each Pairing has
  // playerA + playerB and we want wins per side.
  const confirmedPairings = await prisma.match.findMany({
    where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
    select: {
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
    },
  });
  const matchWinsByPlayer = new Map<string, number>();
  const gameWinsByPlayer = new Map<string, number>();
  for (const p of confirmedPairings) {
    const aWon = p.gamesWonA > p.gamesWonB;
    const bWon = p.gamesWonB > p.gamesWonA;
    if (aWon) matchWinsByPlayer.set(p.playerAId, (matchWinsByPlayer.get(p.playerAId) ?? 0) + 1);
    if (bWon) matchWinsByPlayer.set(p.playerBId, (matchWinsByPlayer.get(p.playerBId) ?? 0) + 1);
    gameWinsByPlayer.set(p.playerAId, (gameWinsByPlayer.get(p.playerAId) ?? 0) + p.gamesWonA);
    gameWinsByPlayer.set(p.playerBId, (gameWinsByPlayer.get(p.playerBId) ?? 0) + p.gamesWonB);
  }
  const allLeaderIds = new Set<string>([...matchWinsByPlayer.keys(), ...gameWinsByPlayer.keys()]);
  const leaderNames = allLeaderIds.size === 0
    ? []
    : await prisma.player.findMany({
        where: { id: { in: [...allLeaderIds] } },
        select: { id: true, displayName: true },
      });
  const nameById = new Map(leaderNames.map((p) => [p.id, p.displayName]));
  const topByMatchWins: StatsLeaderRow[] = [...matchWinsByPlayer.entries()]
    .map(([playerId, value]) => ({
      playerId,
      displayName: nameById.get(playerId) ?? "Unknown",
      value,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const topByGameWins: StatsLeaderRow[] = [...gameWinsByPlayer.entries()]
    .map(([playerId, value]) => ({
      playerId,
      displayName: nameById.get(playerId) ?? "Unknown",
      value,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  // ── Deck + stake aggregates (relational SQL — no JSON parsing) ──────
  // Most-played = picked Game rows per deck/stake (non-DC, confirmed match).
  // _count._all = games played; _count.winnerId = games with a recorded winner.
  const gameWhere = { dcByPlayerId: null, match: { status: "CONFIRMED" as const } };
  const [deckGameAgg, stakeGameAgg] = await Promise.all([
    prisma.game.groupBy({ by: ["deck"], where: gameWhere, _count: { _all: true, winnerId: true } }),
    prisma.game.groupBy({ by: ["stake"], where: gameWhere, _count: { _all: true, winnerId: true } }),
  ]);
  const sortedDecks: StatsDeckRow[] = deckGameAgg
    .map((r) => ({
      name: r.deck,
      gamesTotal: r._count._all,
      gamesWon: r._count.winnerId,
      winRatePct: r._count._all === 0 ? 0 : Math.round((r._count.winnerId / r._count._all) * 100),
    }))
    .sort((a, b) => b.gamesTotal - a.gamesTotal);
  const sortedStakes: StatsDeckRow[] = stakeGameAgg
    .map((r) => ({
      name: r.stake,
      gamesTotal: r._count._all,
      gamesWon: r._count.winnerId,
      winRatePct: r._count._all === 0 ? 0 : Math.round((r._count.winnerId / r._count._all) * 100),
    }))
    .sort((a, b) => b.gamesTotal - a.gamesTotal);
  const mostPlayedDecks = sortedDecks.slice(0, 10);
  const mostPlayedStakes = sortedStakes.slice(0, 10);

  // Most-banned — over the FULL pool (GameDeck): _count._all = appearances,
  // _count.banOrdinal = bans (rows with a ban turn). Exact ban-rate, no JSON.
  // Sorted by raw ban count; filtered to ≥5 appearances to drop flukes.
  const poolWhere = { game: { dcByPlayerId: null, match: { status: "CONFIRMED" as const } } };
  const [deckBanAgg, stakeBanAgg] = await Promise.all([
    prisma.gameDeck.groupBy({ by: ["deck"], where: poolWhere, _count: { _all: true, banOrdinal: true } }),
    prisma.gameDeck.groupBy({ by: ["stake"], where: poolWhere, _count: { _all: true, banOrdinal: true } }),
  ]);
  const sortedBannedDecks: StatsBanRow[] = deckBanAgg
    .filter((r) => r._count._all >= 5)
    .map((r) => ({
      name: r.deck,
      bansTotal: r._count.banOrdinal,
      appearancesTotal: r._count._all,
      banRatePct: r._count._all === 0 ? 0 : Math.round((r._count.banOrdinal / r._count._all) * 100),
    }))
    .sort((a, b) => b.bansTotal - a.bansTotal);
  const sortedBannedStakes: StatsBanRow[] = stakeBanAgg
    .filter((r) => r._count._all >= 5)
    .map((r) => ({
      name: r.stake,
      bansTotal: r._count.banOrdinal,
      appearancesTotal: r._count._all,
      banRatePct: r._count._all === 0 ? 0 : Math.round((r._count.banOrdinal / r._count._all) * 100),
    }))
    .sort((a, b) => b.bansTotal - a.bansTotal);
  const mostBannedDecks = sortedBannedDecks.slice(0, 10);
  const mostBannedStakes = sortedBannedStakes.slice(0, 10);
  // Best/worst kept empty — no useful league-wide reading. The per-
  // player versions on /profile/[id] cover the case where it matters.
  const bestDecks: StatsDeckRow[] = [];
  const worstDecks: StatsDeckRow[] = [];
  const bestStakes: StatsDeckRow[] = [];
  const worstStakes: StatsDeckRow[] = [];
  void MIN_GAMES_FOR_RANKING;

  // ── Longest active streaks ─────────────────────────────────────────
  // For each player who has played at least one match in the active
  // season, walk their confirmed pairings in chronological order. An
  // "active" streak is the run of consecutive 2-0 wins ending at the
  // most recent confirmed match. Draws + losses break it.
  // We DON'T require the streak to be exclusively in the active season
  // — a long streak can span seasons. UI surfaces the count + flags
  // "active" if their last match was a win.
  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true },
  });
  let longestActiveStreaks: StatsStreakRow[] = [];
  if (activeSeason) {
    // Find all players with at least one membership in the active season,
    // then walk their entire confirmed-pairing history (across seasons)
    // sorted by confirmedAt. Cap to 5 results.
    const activeMembers = await prisma.divisionMember.findMany({
      where: { seasonId: activeSeason.id, status: "ACTIVE" },
      select: { playerId: true },
    });
    const activePlayerIds = [...new Set(activeMembers.map((m) => m.playerId))];
    if (activePlayerIds.length > 0) {
      const allPairings = await prisma.match.findMany({
        where: {
          status: "CONFIRMED",
          format: "LEAGUE_BO2",
          OR: [{ playerAId: { in: activePlayerIds } }, { playerBId: { in: activePlayerIds } }],
        },
        select: {
          playerAId: true,
          playerBId: true,
          gamesWonA: true,
          gamesWonB: true,
          confirmedAt: true,
        },
        orderBy: { confirmedAt: "asc" },
      });
      const pairingsByPlayer = new Map<string, typeof allPairings>();
      for (const p of allPairings) {
        for (const pid of [p.playerAId, p.playerBId]) {
          if (!activePlayerIds.includes(pid)) continue;
          const arr = pairingsByPlayer.get(pid) ?? [];
          arr.push(p);
          pairingsByPlayer.set(pid, arr);
        }
      }
      const namesNeeded = await prisma.player.findMany({
        where: { id: { in: activePlayerIds } },
        select: { id: true, displayName: true },
      });
      const namesById = new Map(namesNeeded.map((p) => [p.id, p.displayName]));
      const streaks: StatsStreakRow[] = [];
      for (const [playerId, list] of pairingsByPlayer) {
        // Walk from most recent backwards; count consecutive wins.
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
        if (streak >= 3) {
          streaks.push({
            playerId,
            displayName: namesById.get(playerId) ?? "Unknown",
            streak,
            isActive: activeStreak,
          });
        }
      }
      longestActiveStreaks = streaks
        .sort((a, b) => b.streak - a.streak)
        .slice(0, 5);
    }
  }

  return {
    topByRating,
    topByMatchWins,
    topByGameWins,
    mostPlayedDecks,
    bestDecks,
    worstDecks,
    mostPlayedStakes,
    bestStakes,
    worstStakes,
    mostBannedDecks,
    mostBannedStakes,
    longestActiveStreaks,
  };
}
