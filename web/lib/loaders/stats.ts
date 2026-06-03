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

interface GameStateMin {
  pool?: Array<{ deck: string; stake: string }>;
  pickedDeckIdx?: number;
  winnerId?: string;
  dcByPlayerId?: string;
  bans?: number[];
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
  const confirmedPairings = await prisma.pairing.findMany({
    where: { status: "CONFIRMED" },
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

  // ── Deck + stake aggregates ─────────────────────────────────────────
  // Pull every MatchSession's game JSON across all confirmed pairings;
  // walk each game with a pickedDeckIdx + winnerId; tally deck/stake
  // game counts league-wide. Skip DC games.
  const confirmedPairingIds = confirmedPairings.length === 0
    ? []
    : (await prisma.pairing.findMany({
        where: { status: "CONFIRMED" },
        select: { id: true },
      })).map((p) => p.id);
  const sessions = confirmedPairingIds.length === 0
    ? []
    : await prisma.matchSession.findMany({
        where: { pairingId: { in: confirmedPairingIds } },
        select: { game1: true, game2: true, game3: true },
      });
  const deckAgg = new Map<string, { won: number; total: number }>();
  const stakeAgg = new Map<string, { won: number; total: number }>();
  // Ban counters track two things per deck/stake: total bans and total
  // pool appearances. Ban rate = bans / appearances tells you "when this
  // shows up, how often does someone nuke it" — a stronger signal than
  // raw counts because popular decks naturally appear in more pools.
  const deckBans = new Map<string, { bans: number; appearances: number }>();
  const stakeBans = new Map<string, { bans: number; appearances: number }>();
  for (const s of sessions) {
    for (const json of [s.game1, s.game2, s.game3]) {
      if (!json) continue;
      let game: GameStateMin | null = null;
      try { game = JSON.parse(json) as GameStateMin; } catch { continue; }
      if (!game) continue;
      if (game.dcByPlayerId) continue;
      // Appearance + ban tally over the full pool — independent of
      // whether a deck was picked. Skip games without a real pool
      // (custom-combo proposals + DC games have a length-1 placeholder
      // pool which doesn't reflect ban behavior).
      if (game.pool && game.pool.length > 1) {
        const banSet = new Set(game.bans ?? []);
        for (let i = 0; i < game.pool.length; i++) {
          const combo = game.pool[i]!;
          const dBan = deckBans.get(combo.deck) ?? { bans: 0, appearances: 0 };
          dBan.appearances++;
          if (banSet.has(i)) dBan.bans++;
          deckBans.set(combo.deck, dBan);
          const sBan = stakeBans.get(combo.stake) ?? { bans: 0, appearances: 0 };
          sBan.appearances++;
          if (banSet.has(i)) sBan.bans++;
          stakeBans.set(combo.stake, sBan);
        }
      }
      const idx = game.pickedDeckIdx;
      if (idx === undefined || !game.pool || !game.pool[idx]) continue;
      const combo = game.pool[idx];
      const dRow = deckAgg.get(combo.deck) ?? { won: 0, total: 0 };
      dRow.total++;
      if (game.winnerId) dRow.won++; // any game that has a winner counts toward the deck/stake's "played" count
      deckAgg.set(combo.deck, dRow);
      const sRow = stakeAgg.get(combo.stake) ?? { won: 0, total: 0 };
      sRow.total++;
      if (game.winnerId) sRow.won++;
      stakeAgg.set(combo.stake, sRow);
    }
  }
  // For "win rate" leaderboards we need: of the games played on deck X,
  // how often did SOMEBODY (anybody) win — which always = 100% if every
  // game had a winnerId. That's not the metric we want. The right
  // metric is per-player avg, which is already on the profile.
  // For league-wide "deck performance" we go simpler: just count games
  // played. Decks with more plays → more popular. For a "best win rate"
  // type, fall back to expressing it as the average win rate of the
  // higher-rated half of each game (= 50% deterministically). Skip
  // best/worst league-wide; it doesn't have a useful interpretation
  // without per-player context.
  // Decision: keep only "most played" for league-wide deck/stake.
  // (Best/worst kept in the type for forward-compat but empty for now.)
  const sortedDecks: StatsDeckRow[] = [...deckAgg.entries()]
    .map(([name, c]) => ({
      name,
      gamesTotal: c.total,
      gamesWon: c.won,
      winRatePct: c.total === 0 ? 0 : Math.round((c.won / c.total) * 100),
    }))
    .sort((a, b) => b.gamesTotal - a.gamesTotal);
  const sortedStakes: StatsDeckRow[] = [...stakeAgg.entries()]
    .map(([name, c]) => ({
      name,
      gamesTotal: c.total,
      gamesWon: c.won,
      winRatePct: c.total === 0 ? 0 : Math.round((c.won / c.total) * 100),
    }))
    .sort((a, b) => b.gamesTotal - a.gamesTotal);
  const mostPlayedDecks = sortedDecks.slice(0, 10);
  const mostPlayedStakes = sortedStakes.slice(0, 10);

  // Most-banned decks/stakes — sort by raw ban count so the leaderboard
  // is comparable to "most played" (both popularity-weighted). banRatePct
  // is also exposed so the UI can show "30% banned when present" for
  // colour. Decks with fewer than 5 appearances are filtered to keep
  // single-game flukes off the board.
  const sortedBannedDecks: StatsBanRow[] = [...deckBans.entries()]
    .filter(([, c]) => c.appearances >= 5)
    .map(([name, c]) => ({
      name,
      bansTotal: c.bans,
      appearancesTotal: c.appearances,
      banRatePct: c.appearances === 0 ? 0 : Math.round((c.bans / c.appearances) * 100),
    }))
    .sort((a, b) => b.bansTotal - a.bansTotal);
  const sortedBannedStakes: StatsBanRow[] = [...stakeBans.entries()]
    .filter(([, c]) => c.appearances >= 5)
    .map(([name, c]) => ({
      name,
      bansTotal: c.bans,
      appearancesTotal: c.appearances,
      banRatePct: c.appearances === 0 ? 0 : Math.round((c.bans / c.appearances) * 100),
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
      const allPairings = await prisma.pairing.findMany({
        where: {
          status: "CONFIRMED",
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
