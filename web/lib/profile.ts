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

export interface PlayerHistory {
  player: { id: string; discordId: string; displayName: string; rating: number | null };
  history: SeasonHistoryEntry[];
  totals: { seasons: number; wins: number; draws: number; losses: number; points: number; bestRank: number | null };
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
    select: { id: true, discordId: true, displayName: true, rating: true },
  });
  if (!player) return null;

  // 1) Lightweight memberships — no deep includes.
  const memberships = await prisma.divisionMember.findMany({
    where: { playerId, division: { season: { visibility: "PUBLIC" } } },
    select: {
      status: true,
      divisionId: true,
      division: {
        select: {
          id: true,
          name: true,
          seasonId: true,
          tier: { select: { name: true, position: true } },
          season: { select: { id: true, name: true, isActive: true } },
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });
  if (memberships.length === 0) {
    return { player, history: [], totals: emptyTotals() };
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
      return {
        pairingId: p.id,
        status: p.status === "DISPUTED" ? "DISPUTED" : "CONFIRMED",
        opponentPlayerId: opponent.id,
        opponentDisplayName: opponent.displayName,
        myGames,
        opponentGames: oppGames,
        outcome,
        confirmedAt: p.confirmedAt,
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
      seasonName: m.division.season.name,
      isActive: m.division.season.isActive,
      divisionId: m.division.id,
      divisionName: m.division.name,
      tierName: m.division.tier.name,
      tierPosition: m.division.tier.position,
      rank: myRank,
      totalMembers: cached?.length ?? 0,
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

  const totals = {
    seasons: history.length,
    wins: history.reduce((s, h) => s + h.wins, 0),
    draws: history.reduce((s, h) => s + h.draws, 0),
    losses: history.reduce((s, h) => s + h.losses, 0),
    points: history.reduce((s, h) => s + h.points, 0),
    bestRank: history
      .filter((h) => h.rank > 0)
      .reduce<number | null>((best, h) => (best === null || h.rank < best ? h.rank : best), null),
  };

  return { player, history, totals };
}

function emptyTotals(): PlayerHistory["totals"] {
  return { seasons: 0, wins: 0, draws: 0, losses: 0, points: 0, bestRank: null };
}
