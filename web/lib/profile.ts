// Loader for a player's full season-by-season history (PUBLIC seasons only).
//
// Designed around a single-purpose contract: it returns ONLY what the
// /profile/[id] page renders — header stats, per-season rank + record,
// and the viewing player's own matches. It does NOT load every member of
// every division the player was ever in (the old shape).
//
// Three round trips total, regardless of season count:
//   1. memberships + division/season/tier metadata (lightweight)
//   2. DivisionStandings cache rows for every division-id at once
//   3. The player's OWN pairings across all those divisions at once
//
// Old shape: 1 deep query per season × N seasons, each pulling the
// entire division (all members + all pairings). At 5 seasons × 50-member
// divisions × 1225 pairings, that's ~6k rows transferred to show ~50.
// New shape transfers exactly what the page renders + the cached rank.
//
// Falls back gracefully when DivisionStandings has no cache row (cold
// cache OR DROPPED player who was pruned on last recompute) — the row
// for that season just shows rank=0 with the player's own matches still
// listed. computeStandings is NOT called in this loader; the cache is
// authoritative.

import { prisma } from "./prisma";
import { formatSeasonLabel } from "./format-season";

// One combo in a game's pick/ban pool, in pool order. `picked` = the combo the
// game was played on; otherwise `banOrdinal` (1-based) is the order it was
// banned and `bannedByMe` says which side did it.
export interface GameBan {
  deck: string;
  stake: string;
  picked: boolean;
  banOrdinal: number | null;
  bannedByMe: boolean | null; // true = you, false = opponent, null = survived (the pick)
}

export interface GamePlayed {
  // 1, 2, or 3 — index into the match's games. Shootouts only have
  // game 1.
  num: 1 | 2 | 3;
  // Null for a lives-only manual report (no per-game deck/stake captured).
  deck: string | null;
  stake: string | null;
  // True/false from this player's perspective. Null if the game's
  // winnerId wasn't recorded (rare — disputes, custom-combo edge
  // cases). UI hides indeterminate games rather than guessing.
  iWon: boolean | null;
  // Winner's lives remaining this game, if captured (attrition tiebreaker).
  lives: number | null;
  // The full pick/ban pool for this game (empty for manual/lives-only reports).
  pool: GameBan[];
}

export interface MatchEntry {
  pairingId: string;
  status: "CONFIRMED" | "DISPUTED";
  opponentPlayerId: string;
  opponentDisplayName: string;
  myGames: number;
  opponentGames: number;
  outcome: "WIN" | "DRAW" | "LOSS";
  confirmedAt: Date | null;
  // True when this entry is a 1-game shootout tiebreaker, not a normal
  // best-of-2 pairing. UI renders these with a "⚔ shootout" marker.
  isShootout?: boolean;
  // Per-game deck/stake breakdown when the match went through
  // /start-match (MatchSession recorded). Empty array for /report-only
  // matches and admin record-set matches — no session = no deck data.
  games: GamePlayed[];
}

export interface SeasonHistoryEntry {
  seasonId: string;
  seasonName: string;
  isActive: boolean;
  divisionId: string;
  divisionName: string;
  tierName: string;
  tierPosition: number;
  rank: number;          // 0 when no cache row exists (cold or dropped)
  totalMembers: number;
  // Snapshot of Player.rating at the moment THIS season was BUILT
  // (entered). Null for players who had no Player.rating yet at build
  // time. Use with finalGlobalRank to show the arc:
  // "Entered as #N → finished as #M".
  seedRank: number | null;
  // Snapshot of the player's global rank (= Player.rating) at the
  // moment THIS season ended. Null if the season hasn't ended yet OR
  // ended before the snapshot column existed (no backfill). Used to
  // show "Season 4 final global rank: 47" on the history view —
  // doesn't shift when later seasons rewrite Player.rating.
  finalGlobalRank: number | null;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  played: number;
  status: "ACTIVE" | "DROPPED";
  matches: MatchEntry[];
}

// One row per unique deck (or stake) this player has played, with
// game-level win counts. Sorted by win rate desc with minimum-games
// filter applied at the caller so rare-sample decks don't dominate.
export interface PerComboPerformance {
  name: string;
  gamesWon: number;
  gamesTotal: number;
  winRatePct: number;
}

// "Favourites" — top-5 cuts by raw count (not win rate). Most-played = how
// often the player was on it; most-won = how many they won on it. Computed
// for decks, stakes, and the deck+stake combo.
export interface FavoriteEntry {
  name: string;
  gamesPlayed: number;
  gamesWon: number;
}
export interface Favorites {
  mostPlayed: { decks: FavoriteEntry[]; stakes: FavoriteEntry[]; combos: FavoriteEntry[] };
  mostWon: { decks: FavoriteEntry[]; stakes: FavoriteEntry[]; combos: FavoriteEntry[] };
}

// Aggregate record against one specific opponent across all confirmed
// matches in any season. Match-level (W/D/L) and game-level
// (gamesWon/gamesLost) both surfaced.
export interface HeadToHead {
  opponentPlayerId: string;
  opponentDisplayName: string;
  wins: number;
  draws: number;
  losses: number;
  totalMatches: number;
  gamesWon: number;
  gamesLost: number;
}

export interface PlayerHistory {
  player: { id: string; discordId: string; displayName: string; username: string | null; rating: number | null };
  history: SeasonHistoryEntry[];
  totals: {
    seasons: number;
    wins: number;
    draws: number;
    losses: number;
    points: number;
    bestRank: number | null;
    // Match-level rates across the career — what % of CONFIRMED matches
    // ended 2-0 for / 1-1 / 0-2 for. Null when the player has zero
    // confirmed matches (can't divide by zero).
    winRatePct: number | null;
    drawRatePct: number | null;
    lossRatePct: number | null;
    // Game-level rate: gamesWon / (gamesWon + gamesLost). Finer-grained
    // than the match-level rate — a 2-0/0-2/1-1 player has match win%
    // of 33 but game win% of 50.
    gameWinRatePct: number | null;
    totalMatches: number;
    totalGames: number;
  };
  // Per-deck and per-stake win rates aggregated from MatchSession
  // game JSON. Only games that went through /start-match contribute
  // (admin record-set + /report-only matches don't have deck info).
  // Empty arrays when the player has zero recorded games.
  deckPerformance: PerComboPerformance[];
  stakePerformance: PerComboPerformance[];
  favorites: Favorites;
  // Head-to-head records against every player this person has played.
  // Sorted by totalMatches desc. UI typically shows just the top N or
  // filters to the viewer-vs-profile-owner row.
  headToHeads: HeadToHead[];
}

// Shape of the JSON payload written by recomputeDivisionStandings.
// Kept in sync manually with src/standings-cache.ts CachedRow — both
// sides serialize the same fields so this can deserialize either's
// output.
interface CachedRow {
  playerId: string;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  played: number;
}

export async function loadPlayerHistory(playerId: string): Promise<PlayerHistory | null> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, discordId: true, displayName: true, username: true, rating: true },
  });
  if (!player) return null;

  // 1) Lightweight memberships — no deep includes.
  // Hide DRAFT seasons (never activated AND not yet ended) from the
  // career timeline; active and ended seasons both show.
  const memberships = await prisma.divisionMember.findMany({
    where: {
      playerId,
      division: { season: { OR: [{ isActive: true }, { endedAt: { not: null } }] } },
    },
    select: {
      status: true,
      divisionId: true,
      seedRank: true,
      finalGlobalRank: true,
      division: {
        select: {
          id: true,
          name: true,
          seasonId: true,
          tier: { select: { name: true, position: true } },
          season: { select: { id: true, number: true, subtitle: true, isActive: true } },
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });
  if (memberships.length === 0) {
    return {
      player,
      history: [],
      totals: emptyTotals(),
      deckPerformance: [],
      stakePerformance: [],
      favorites: {
        mostPlayed: { decks: [], stakes: [], combos: [] },
        mostWon: { decks: [], stakes: [], combos: [] },
      },
      headToHeads: [],
    };
  }
  const divisionIds = memberships.map((m) => m.divisionId);

  // 2) Cached standings rows for every division at once. Misses are
  // expected (cold cache, dropped players); we handle them below.
  const standingsRows = await prisma.divisionStandings.findMany({
    where: { divisionId: { in: divisionIds } },
    select: { divisionId: true, rowsJson: true },
  });
  const standingsByDivision = new Map<string, CachedRow[]>();
  for (const s of standingsRows) {
    try {
      standingsByDivision.set(s.divisionId, JSON.parse(s.rowsJson) as CachedRow[]);
    } catch {
      // Bad JSON — skip. UI falls back to rank=0.
    }
  }

  // 3) The viewing player's OWN matches across all those divisions in one
  // round trip — the unified Match model, so BO2 series AND shootouts come
  // back together (format distinguishes them), each with its per-game rows
  // (deck/stake/winner). No JSON, no separate shootout/session queries.
  // CONFIRMED + DISPUTED; DISPUTED renders a badge + "Update dispute" button.
  // Match by the player directly (indexed on both playerAId and playerBId) —
  // NOT by `divisionId IN [all their divisions]`, which made Postgres scan
  // every match in those divisions. A player's matches are all in divisions
  // they're a member of, so the division filter was redundant; we still group
  // by mm.divisionId below.
  const myMatches = await prisma.match.findMany({
    where: {
      status: { in: ["CONFIRMED", "DISPUTED"] },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: {
      id: true,
      format: true,
      status: true,
      divisionId: true,
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
      winnerId: true,
      confirmedAt: true,
      playerA: { select: { id: true, displayName: true } },
      playerB: { select: { id: true, displayName: true } },
      games: {
        select: {
          num: true, deck: true, stake: true, winnerId: true, winnerLives: true, dcByPlayerId: true,
          pool: {
            select: { poolIdx: true, deck: true, stake: true, picked: true, banOrdinal: true, bannedById: true },
            orderBy: { poolIdx: "asc" },
          },
        },
        orderBy: { num: "asc" },
      },
    },
    orderBy: { confirmedAt: "asc" },
  });
  const matchesByDivision = new Map<string, typeof myMatches>();
  for (const mm of myMatches) {
    const bucket = matchesByDivision.get(mm.divisionId);
    if (bucket) bucket.push(mm);
    else matchesByDivision.set(mm.divisionId, [mm]);
  }

  // Aggregate per-deck + per-stake game counts across this player's
  // career. iterated inline below as we walk the matches.
  const deckAgg = new Map<string, { won: number; total: number }>();
  const stakeAgg = new Map<string, { won: number; total: number }>();
  const comboAgg = new Map<string, { won: number; total: number }>();
  const bumpAgg = (
    map: Map<string, { won: number; total: number }>,
    key: string,
    won: boolean,
  ) => {
    const cur = map.get(key) ?? { won: 0, total: 0 };
    cur.total += 1;
    if (won) cur.won += 1;
    map.set(key, cur);
  };

  // Per-game breakdown for a match (Game rows) → GamePlayed[] for the UI,
  // folding the per-deck/stake aggregates. DC games are excluded from the
  // aggregates (forfeit, not really played) but still shown in history.
  function gamesFromMatch(match: (typeof myMatches)[number]): GamePlayed[] {
    const result: GamePlayed[] = [];
    for (const g of match.games) {
      const iWon = g.winnerId == null ? null : g.winnerId === playerId;
      const num = (g.num === 3 ? 3 : g.num === 2 ? 2 : 1) as 1 | 2 | 3;
      const pool: GameBan[] = g.pool.map((pd) => ({
        deck: pd.deck,
        stake: pd.stake,
        picked: pd.picked,
        banOrdinal: pd.banOrdinal,
        bannedByMe: pd.bannedById == null ? null : pd.bannedById === playerId,
      }));
      result.push({ num, deck: g.deck, stake: g.stake, iWon, lives: g.winnerLives, pool });
      if (iWon === null) continue;
      if (g.dcByPlayerId) continue;
      // Lives-only manual reports have no deck/stake — skip the per-combo
      // aggregates for them (they still show in the per-game history above).
      if (g.deck && g.stake) {
        bumpAgg(deckAgg, g.deck, iWon);
        bumpAgg(stakeAgg, g.stake, iWon);
        bumpAgg(comboAgg, `${g.deck} · ${g.stake}`, iWon);
      }
    }
    return result;
  }

  const history: SeasonHistoryEntry[] = [];
  for (const m of memberships) {
    const cached = standingsByDivision.get(m.divisionId);
    const myCached = cached?.find((r) => r.playerId === playerId);
    const myRank = cached
      ? cached.findIndex((r) => r.playerId === playerId) + 1
      : 0;

    // Both formats come from the unified Match query. A shootout (1-game) has
    // gamesWonA/B of 1/0 and no draw; a BO2 derives WIN/DRAW/LOSS from the
    // game tally. Already ordered by confirmedAt from the query.
    const matches: MatchEntry[] = (matchesByDivision.get(m.divisionId) ?? []).map((mm): MatchEntry => {
      const meIsA = mm.playerAId === playerId;
      const opponent = meIsA ? mm.playerB : mm.playerA;
      const myGames = meIsA ? mm.gamesWonA : mm.gamesWonB;
      const oppGames = meIsA ? mm.gamesWonB : mm.gamesWonA;
      const isShootout = mm.format === "SHOOTOUT_BO1";
      const outcome: MatchEntry["outcome"] = isShootout
        ? mm.winnerId === playerId
          ? "WIN"
          : "LOSS"
        : myGames > oppGames
          ? "WIN"
          : myGames < oppGames
            ? "LOSS"
            : "DRAW";
      return {
        pairingId: mm.id,
        status: mm.status === "DISPUTED" ? "DISPUTED" : "CONFIRMED",
        opponentPlayerId: opponent.id,
        opponentDisplayName: opponent.displayName,
        myGames,
        opponentGames: oppGames,
        outcome,
        confirmedAt: mm.confirmedAt,
        isShootout,
        games: gamesFromMatch(mm),
      };
    });

    // Stats: prefer the cached row when present (authoritative — same
    // numbers as /standings). Fall back to deriving from the player's
    // own matches for dropped players (cache excludes them) or cold-cache
    // divisions. Points use default 3/1/0; if the league has tuned
    // scoring, the cached row already reflects that — fallback path
    // would only fire for cold-cache divisions where points haven't
    // been computed yet anyway.
    // Shootouts don't roll up into points/wins (they break ties, they're
    // not a results row), so exclude them from the derived stats fallback.
    const confirmedMatches = matches.filter((mm) => mm.status === "CONFIRMED" && !mm.isShootout);
    const derivedWins = confirmedMatches.filter((mm) => mm.outcome === "WIN").length;
    const derivedDraws = confirmedMatches.filter((mm) => mm.outcome === "DRAW").length;
    const derivedLosses = confirmedMatches.filter((mm) => mm.outcome === "LOSS").length;
    const derivedGamesWon = confirmedMatches.reduce((s, mm) => s + mm.myGames, 0);
    const derivedGamesLost = confirmedMatches.reduce((s, mm) => s + mm.opponentGames, 0);

    history.push({
      seasonId: m.division.season.id,
      seasonName: formatSeasonLabel(m.division.season),
      isActive: m.division.season.isActive,
      divisionId: m.division.id,
      divisionName: m.division.name,
      tierName: m.division.tier.name,
      tierPosition: m.division.tier.position,
      rank: myRank,
      totalMembers: cached?.length ?? 0,
      seedRank: m.seedRank,
      finalGlobalRank: m.finalGlobalRank,
      points: myCached?.points ?? derivedWins * 3 + derivedDraws * 1,
      wins: myCached?.wins ?? derivedWins,
      draws: myCached?.draws ?? derivedDraws,
      losses: myCached?.losses ?? derivedLosses,
      gamesWon: myCached?.gamesWon ?? derivedGamesWon,
      gamesLost: myCached?.gamesLost ?? derivedGamesLost,
      played: myCached?.played ?? confirmedMatches.length,
      status: m.status,
      matches,
    });
  }

  const totalWins = history.reduce((s, h) => s + h.wins, 0);
  const totalDraws = history.reduce((s, h) => s + h.draws, 0);
  const totalLosses = history.reduce((s, h) => s + h.losses, 0);
  const totalGamesWon = history.reduce((s, h) => s + h.gamesWon, 0);
  const totalGamesLost = history.reduce((s, h) => s + h.gamesLost, 0);
  const totalMatches = totalWins + totalDraws + totalLosses;
  const totalGames = totalGamesWon + totalGamesLost;
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 100));

  const totals = {
    seasons: history.length,
    wins: totalWins,
    draws: totalDraws,
    losses: totalLosses,
    points: history.reduce((s, h) => s + h.points, 0),
    bestRank: history
      .filter((h) => h.rank > 0)
      .reduce<number | null>((best, h) => (best === null || h.rank < best ? h.rank : best), null),
    winRatePct: pct(totalWins, totalMatches),
    drawRatePct: pct(totalDraws, totalMatches),
    lossRatePct: pct(totalLosses, totalMatches),
    gameWinRatePct: pct(totalGamesWon, totalGames),
    totalMatches,
    totalGames,
  };

  // Per-deck + per-stake performance from the aggregated counts. Sort
  // by win rate desc within (sample size desc) so a 100%/2 doesn't
  // shadow a 75%/12 — the larger sample wins ties. UI applies its
  // own minimum-games filter so we surface all data here.
  const buildPerf = (agg: Map<string, { won: number; total: number }>): PerComboPerformance[] =>
    [...agg.entries()]
      .map(([name, c]) => ({
        name,
        gamesWon: c.won,
        gamesTotal: c.total,
        winRatePct: c.total === 0 ? 0 : Math.round((c.won / c.total) * 100),
      }))
      .sort((a, b) => {
        if (a.winRatePct !== b.winRatePct) return b.winRatePct - a.winRatePct;
        return b.gamesTotal - a.gamesTotal;
      });
  const deckPerformance = buildPerf(deckAgg);
  const stakePerformance = buildPerf(stakeAgg);

  // Favourites: top-5 by raw count. "played" sorts by total games on it;
  // "won" sorts by games won (ties broken by the other).
  const topBy = (
    agg: Map<string, { won: number; total: number }>,
    by: "played" | "won",
    n = 5,
  ): FavoriteEntry[] =>
    [...agg.entries()]
      .map(([name, c]) => ({ name, gamesPlayed: c.total, gamesWon: c.won }))
      .filter((e) => (by === "won" ? e.gamesWon > 0 : e.gamesPlayed > 0))
      .sort((a, b) =>
        by === "won"
          ? b.gamesWon - a.gamesWon || b.gamesPlayed - a.gamesPlayed
          : b.gamesPlayed - a.gamesPlayed || b.gamesWon - a.gamesWon,
      )
      .slice(0, n);
  const favorites: Favorites = {
    mostPlayed: { decks: topBy(deckAgg, "played"), stakes: topBy(stakeAgg, "played"), combos: topBy(comboAgg, "played") },
    mostWon: { decks: topBy(deckAgg, "won"), stakes: topBy(stakeAgg, "won"), combos: topBy(comboAgg, "won") },
  };

  // Head-to-head: group pairings by opponent, sum match outcomes +
  // game totals. Shootouts excluded — they're tiebreakers, not
  // recorded as career H2H wins. Disputed pairings included but use
  // the current gamesWonA/B which may be the disputer's proposed
  // values; UI doesn't distinguish.
  const h2hByOpp = new Map<
    string,
    { displayName: string; wins: number; draws: number; losses: number; gamesWon: number; gamesLost: number }
  >();
  for (const mm of myMatches) {
    if (mm.status !== "CONFIRMED") continue;
    if (mm.format === "SHOOTOUT_BO1") continue; // tiebreakers aren't career H2H
    const meIsA = mm.playerAId === playerId;
    const opp = meIsA ? mm.playerB : mm.playerA;
    const myG = meIsA ? mm.gamesWonA : mm.gamesWonB;
    const oppG = meIsA ? mm.gamesWonB : mm.gamesWonA;
    const cur = h2hByOpp.get(opp.id) ?? {
      displayName: opp.displayName,
      wins: 0,
      draws: 0,
      losses: 0,
      gamesWon: 0,
      gamesLost: 0,
    };
    if (myG > oppG) cur.wins++;
    else if (myG < oppG) cur.losses++;
    else cur.draws++;
    cur.gamesWon += myG;
    cur.gamesLost += oppG;
    h2hByOpp.set(opp.id, cur);
  }
  const headToHeads: HeadToHead[] = [...h2hByOpp.entries()]
    .map(([opponentPlayerId, v]) => ({
      opponentPlayerId,
      opponentDisplayName: v.displayName,
      wins: v.wins,
      draws: v.draws,
      losses: v.losses,
      totalMatches: v.wins + v.draws + v.losses,
      gamesWon: v.gamesWon,
      gamesLost: v.gamesLost,
    }))
    .sort((a, b) => b.totalMatches - a.totalMatches);

  return { player, history, totals, deckPerformance, stakePerformance, favorites, headToHeads };
}

// One deck/stake this player has banned, with how often they banned it vs.
// how often it appeared in their pools (ban rate). Mirrors the league-wide
// ban rate on /stats, but scoped to this player.
export interface BanStatEntry {
  name: string;
  bans: number;
  appearances: number;
  banRatePct: number;
}
export interface PlayerBanStats {
  decks: BanStatEntry[];
  stakes: BanStatEntry[];
}

// What a player bans, from the full GameDeck pools of their confirmed games.
// For each deck/stake: appearances = times it was in their pool; bans = times
// THEY banned it. Returned top-5 by ban count (tie-broken by rate).
export async function loadPlayerBanStats(playerId: string): Promise<PlayerBanStats> {
  const games = await prisma.game.findMany({
    where: {
      dcByPlayerId: null,
      match: { status: "CONFIRMED", OR: [{ playerAId: playerId }, { playerBId: playerId }] },
    },
    select: { pool: { select: { deck: true, stake: true, bannedById: true } } },
  });

  const deckApp = new Map<string, number>();
  const deckBan = new Map<string, number>();
  const stakeApp = new Map<string, number>();
  const stakeBan = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const g of games) {
    for (const d of g.pool) {
      bump(deckApp, d.deck);
      bump(stakeApp, d.stake);
      if (d.bannedById === playerId) {
        bump(deckBan, d.deck);
        bump(stakeBan, d.stake);
      }
    }
  }

  const build = (appMap: Map<string, number>, banMap: Map<string, number>): BanStatEntry[] =>
    [...banMap.entries()]
      .map(([name, bans]) => {
        const appearances = appMap.get(name) ?? bans;
        return { name, bans, appearances, banRatePct: appearances === 0 ? 0 : Math.round((bans / appearances) * 100) };
      })
      .sort((a, b) => b.bans - a.bans || b.banRatePct - a.banRatePct)
      .slice(0, 5);

  return { decks: build(deckApp, deckBan), stakes: build(stakeApp, stakeBan) };
}

function emptyTotals(): PlayerHistory["totals"] {
  return {
    seasons: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    points: 0,
    bestRank: null,
    winRatePct: null,
    drawRatePct: null,
    lossRatePct: null,
    gameWinRatePct: null,
    totalMatches: 0,
    totalGames: 0,
  };
}
