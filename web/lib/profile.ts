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

export interface GamePlayed {
  // 1, 2, or 3 — index into the match's games. Shootouts only have
  // game 1.
  num: 1 | 2 | 3;
  deck: string;
  stake: string;
  // True/false from this player's perspective. Null if the game's
  // winnerId wasn't recorded (rare — disputes, custom-combo edge
  // cases). UI hides indeterminate games rather than guessing.
  iWon: boolean | null;
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
  player: { id: string; discordId: string; displayName: string; rating: number | null };
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

// Subset of the bot-side GameState we need on the web for deck/stake
// extraction. Kept minimal so a schema drift on the bot side doesn't
// quietly break the loader — extra fields are ignored.
interface GameStateMin {
  pool?: Array<{ deck: string; stake: string }>;
  pickedDeckIdx?: number;
  winnerId?: string;
  dcByPlayerId?: string;
}

export async function loadPlayerHistory(playerId: string): Promise<PlayerHistory | null> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, discordId: true, displayName: true, rating: true },
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

  // 3) The viewing player's OWN pairings across all those divisions in
  // one round trip. CONFIRMED + DISPUTED — DISPUTED rows render with a
  // badge and a "Update dispute" button.
  const myPairings = await prisma.pairing.findMany({
    where: {
      divisionId: { in: divisionIds },
      status: { in: ["CONFIRMED", "DISPUTED"] },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: {
      id: true,
      status: true,
      divisionId: true,
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
      confirmedAt: true,
      playerA: { select: { id: true, displayName: true } },
      playerB: { select: { id: true, displayName: true } },
    },
    orderBy: { confirmedAt: "asc" },
  });
  const pairingsByDivision = new Map<string, typeof myPairings>();
  for (const p of myPairings) {
    const bucket = pairingsByDivision.get(p.divisionId);
    if (bucket) bucket.push(p);
    else pairingsByDivision.set(p.divisionId, [p]);
  }

  // For per-match deck/stake breakdown + per-deck/stake aggregates,
  // join the MatchSession rows that resulted in these pairings. A
  // pairing may have no session (admin record-set, /report-only) —
  // those just won't contribute deck data.
  const sessions = myPairings.length === 0 ? [] : await prisma.matchSession.findMany({
    where: { pairingId: { in: myPairings.map((p) => p.id) } },
    select: {
      pairingId: true,
      playerAId: true,
      playerBId: true,
      game1: true,
      game2: true,
      game3: true,
    },
  });
  const sessionsByPairingId = new Map<string, typeof sessions[number]>();
  for (const s of sessions) {
    if (s.pairingId) sessionsByPairingId.set(s.pairingId, s);
  }

  // Aggregate per-deck + per-stake game counts across this player's
  // career. iterated inline below as we walk the matches.
  const deckAgg = new Map<string, { won: number; total: number }>();
  const stakeAgg = new Map<string, { won: number; total: number }>();
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

  // Extract this player's games from a session — returns the per-game
  // breakdown to attach to the MatchEntry AND folds the aggregates.
  // dcByPlayerId games are excluded from per-deck/stake stats since
  // they weren't actually played (forfeit by disconnect).
  function gamesFromSession(
    session: typeof sessions[number],
  ): GamePlayed[] {
    const result: GamePlayed[] = [];
    const meIsA = session.playerAId === playerId;
    const meId = meIsA ? session.playerAId : session.playerBId;
    for (const [num, json] of [
      [1, session.game1] as const,
      [2, session.game2] as const,
      [3, session.game3] as const,
    ]) {
      if (!json) continue;
      let game: GameStateMin | null = null;
      try { game = JSON.parse(json) as GameStateMin; } catch { continue; }
      if (!game) continue;
      const idx = game.pickedDeckIdx;
      if (idx === undefined || !game.pool || !game.pool[idx]) continue;
      const combo = game.pool[idx];
      const winnerId = game.winnerId ?? null;
      const iWon = winnerId == null ? null : winnerId === meId;
      result.push({ num: num as 1 | 2 | 3, deck: combo.deck, stake: combo.stake, iWon });
      // Skip aggregates if winner indeterminate OR forfeit (DC).
      if (iWon === null) continue;
      if (game.dcByPlayerId) continue;
      bumpAgg(deckAgg, combo.deck, iWon);
      bumpAgg(stakeAgg, combo.stake, iWon);
    }
    return result;
  }

  // Shootouts the player participated in across all those divisions.
  // Shootout has no Player relation in the schema (kept simple — ids
  // only), so we batch-fetch the opponent display names in one
  // round-trip after this query.
  const myShootouts = await prisma.shootout.findMany({
    where: {
      divisionId: { in: divisionIds },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  const opponentIds = new Set<string>();
  for (const s of myShootouts) {
    opponentIds.add(s.playerAId === playerId ? s.playerBId : s.playerAId);
  }
  const opponentRows = opponentIds.size
    ? await prisma.player.findMany({
        where: { id: { in: [...opponentIds] } },
        select: { id: true, displayName: true },
      })
    : [];
  const playerNameById = new Map(opponentRows.map((p) => [p.id, p.displayName]));
  const shootoutsByDivision = new Map<string, typeof myShootouts>();
  for (const s of myShootouts) {
    const bucket = shootoutsByDivision.get(s.divisionId);
    if (bucket) bucket.push(s);
    else shootoutsByDivision.set(s.divisionId, [s]);
  }

  const history: SeasonHistoryEntry[] = [];
  for (const m of memberships) {
    const cached = standingsByDivision.get(m.divisionId);
    const myCached = cached?.find((r) => r.playerId === playerId);
    const myRank = cached
      ? cached.findIndex((r) => r.playerId === playerId) + 1
      : 0;

    const pairingMatches: MatchEntry[] = (pairingsByDivision.get(m.divisionId) ?? []).map((p): MatchEntry => {
      const meIsA = p.playerAId === playerId;
      const opponent = meIsA ? p.playerB : p.playerA;
      const myGames = meIsA ? p.gamesWonA : p.gamesWonB;
      const oppGames = meIsA ? p.gamesWonB : p.gamesWonA;
      const outcome: MatchEntry["outcome"] =
        myGames > oppGames ? "WIN" : myGames < oppGames ? "LOSS" : "DRAW";
      const session = sessionsByPairingId.get(p.id);
      const games = session ? gamesFromSession(session) : [];
      return {
        pairingId: p.id,
        status: p.status === "DISPUTED" ? "DISPUTED" : "CONFIRMED",
        opponentPlayerId: opponent.id,
        opponentDisplayName: opponent.displayName,
        myGames,
        opponentGames: oppGames,
        outcome,
        confirmedAt: p.confirmedAt,
        games,
      };
    });
    // Shootouts as MatchEntry rows. 1-game format → myGames/opponentGames
    // are 0 or 1. Draw isn't possible for a shootout. UI distinguishes via
    // isShootout flag.
    const shootoutMatches: MatchEntry[] = (shootoutsByDivision.get(m.divisionId) ?? []).map((s): MatchEntry => {
      const opponentId = s.playerAId === playerId ? s.playerBId : s.playerAId;
      const opponentName = playerNameById.get(opponentId) ?? "Unknown";
      const iWon = s.winnerId === playerId;
      return {
        pairingId: s.id,
        status: "CONFIRMED",
        opponentPlayerId: opponentId,
        opponentDisplayName: opponentName,
        myGames: iWon ? 1 : 0,
        opponentGames: iWon ? 0 : 1,
        outcome: iWon ? "WIN" : "LOSS",
        confirmedAt: s.recordedAt,
        isShootout: true,
        games: [], // shootouts don't have ban/pick combos stored — skip
      };
    });
    // Combine + sort chronologically. Shootouts don't roll up into points
    // (the cached row's wins/draws/losses/games don't reflect them — they're
    // a tiebreaker only), so we DON'T add them to derived stats below.
    const matches: MatchEntry[] = [...pairingMatches, ...shootoutMatches].sort((a, b) => {
      const aT = a.confirmedAt?.getTime() ?? 0;
      const bT = b.confirmedAt?.getTime() ?? 0;
      return aT - bT;
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

  // Head-to-head: group pairings by opponent, sum match outcomes +
  // game totals. Shootouts excluded — they're tiebreakers, not
  // recorded as career H2H wins. Disputed pairings included but use
  // the current gamesWonA/B which may be the disputer's proposed
  // values; UI doesn't distinguish.
  const h2hByOpp = new Map<
    string,
    { displayName: string; wins: number; draws: number; losses: number; gamesWon: number; gamesLost: number }
  >();
  for (const p of myPairings) {
    if (p.status !== "CONFIRMED") continue;
    const meIsA = p.playerAId === playerId;
    const opp = meIsA ? p.playerB : p.playerA;
    const myG = meIsA ? p.gamesWonA : p.gamesWonB;
    const oppG = meIsA ? p.gamesWonB : p.gamesWonA;
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

  return { player, history, totals, deckPerformance, stakePerformance, headToHeads };
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
