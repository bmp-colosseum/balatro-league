// Loader for the public /divisions/[id] page. Returns:
//   - Division header (name, season, tier)
//   - Cached standings rows + which players are dropped
//   - Recent confirmed pairings (top 30, newest first)
//   - Unplayed matchups across ACTIVE members
//
// Uses the DivisionStandings cache for the standings rows rather than
// recomputing in-process. Pairings include the playerA + playerB
// display names so the rendering doesn't need a second hydration pass.

import { prisma } from "@/lib/prisma";
import { loadDivisionStandings } from "@/lib/standings-cache";

export interface DivisionStandingRow {
  player: { id: string; displayName: string };
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  played: number;
  tiedWithPrev?: boolean;
  dropped: boolean;
}

export interface DivisionRecentPairing {
  id: string;
  date: Date | null;
  playerA: { id: string; displayName: string };
  playerB: { id: string; displayName: string };
  gamesWonA: number;
  gamesWonB: number;
}

// One row per shootout in this division. Surfaced as its own list on
// the public page so readers can see how a tied pair was broken
// without having to dig through standings logic.
export interface DivisionShootout {
  id: string;
  recordedAt: Date;
  winner: { id: string; displayName: string };
  loser: { id: string; displayName: string };
  notes: string | null;
  selfReported: boolean;
}

export interface DivisionUnplayed {
  a: { id: string; displayName: string };
  b: { id: string; displayName: string };
}

// Crosstable / scoring matrix. Each row is a player; each cell shows the
// games that row-player won against the column-player from their pairing
// (or null if they haven't played yet, or undefined for the diagonal).
// `totalGamesWon` is the sum across the row — equivalent to gamesWon on
// the standings row, recomputed here so the crosstable is self-contained.
export interface CrosstableCell {
  gamesWon: number | null;
  pairingId: string | null;
}
export interface CrosstableRow {
  player: { id: string; displayName: string };
  cells: Array<CrosstableCell | null>; // null at diagonal index
  totalGamesWon: number;
}
export interface Crosstable {
  players: Array<{ id: string; displayName: string }>;
  rows: CrosstableRow[];
}

export interface DivisionPageData {
  division: {
    id: string;
    name: string;
    seasonId: string;
    seasonName: string;
    tierName: string;
    tierPosition: number;
    activeCount: number;
    confirmedPairingCount: number;
  };
  standings: DivisionStandingRow[];
  recentPairings: DivisionRecentPairing[];
  shootouts: DivisionShootout[];
  unplayed: DivisionUnplayed[];
  crosstable: Crosstable;
}

const RECENT_PAIRINGS_LIMIT = 30;

export async function loadDivisionPageData(divisionId: string): Promise<DivisionPageData | null> {
  const division = await prisma.division.findFirst({
    where: { id: divisionId, season: { visibility: "PUBLIC" } },
    select: {
      id: true,
      name: true,
      seasonId: true,
      tier: { select: { name: true, position: true } },
      season: { select: { name: true } },
      members: {
        select: {
          playerId: true,
          status: true,
          player: { select: { id: true, displayName: true } },
        },
        orderBy: { joinedAt: "asc" },
      },
    },
  });
  if (!division) return null;

  const droppedIds = new Set(
    division.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
  );
  const activeMembers = division.members.filter((m) => m.status === "ACTIVE");

  // Cached standings — same source as /standings, no recompute.
  const standingsRows = await loadDivisionStandings(divisionId);
  const standings: DivisionStandingRow[] = standingsRows.map((r) => ({
    player: { id: r.player.id, displayName: r.player.displayName },
    points: r.points,
    wins: r.wins,
    draws: r.draws,
    losses: r.losses,
    gamesWon: r.gamesWon,
    gamesLost: r.gamesLost,
    played: r.played,
    tiedWithPrev: r.tiedWithPrev,
    dropped: droppedIds.has(r.player.id),
  }));

  const pairings = await prisma.pairing.findMany({
    where: { divisionId, status: "CONFIRMED" },
    select: {
      id: true,
      confirmedAt: true,
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
      playerA: { select: { id: true, displayName: true } },
      playerB: { select: { id: true, displayName: true } },
    },
    orderBy: { confirmedAt: "desc" },
  });
  const recentPairings: DivisionRecentPairing[] = pairings
    .slice(0, RECENT_PAIRINGS_LIMIT)
    .map((p) => ({
      id: p.id,
      date: p.confirmedAt,
      playerA: p.playerA,
      playerB: p.playerB,
      gamesWonA: p.gamesWonA,
      gamesWonB: p.gamesWonB,
    }));

  // Unplayed matchups across ACTIVE members. O(N^2) but N <= 10ish.
  const playedKey = (a: string, b: string) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const playedSet = new Set(pairings.map((p) => playedKey(p.playerAId, p.playerBId)));
  const unplayed: DivisionUnplayed[] = [];
  for (let i = 0; i < activeMembers.length; i++) {
    for (let j = i + 1; j < activeMembers.length; j++) {
      const a = activeMembers[i]!.player;
      const b = activeMembers[j]!.player;
      if (!playedSet.has(playedKey(a.id, b.id))) {
        unplayed.push({ a, b });
      }
    }
  }

  // Shootouts — separate model from Pairing. We resolve the two players
  // through the active-member list (which is already loaded) so we
  // avoid an extra round trip per shootout.
  const memberById = new Map(division.members.map((m) => [m.playerId, m.player]));
  const rawShootouts = await prisma.shootout.findMany({
    where: { divisionId },
    orderBy: { recordedAt: "desc" },
  });
  const shootouts: DivisionShootout[] = rawShootouts.flatMap((s) => {
    const a = memberById.get(s.playerAId);
    const b = memberById.get(s.playerBId);
    if (!a || !b) return [];
    const winner = s.winnerId === a.id ? a : b;
    const loser = s.winnerId === a.id ? b : a;
    return [{
      id: s.id,
      recordedAt: s.recordedAt,
      winner,
      loser,
      notes: s.notes ?? null,
      selfReported: s.recordedBy === "self-report",
    }];
  });

  // Build the crosstable. Players are ordered the SAME as standings
  // (point-ranked) so the matrix matches what readers see above.
  // Rendered with the diagonal blank.
  const crosstablePlayers = standings.length > 0
    ? standings.map((s) => s.player)
    : activeMembers.map((m) => m.player);
  const idxByPlayerId = new Map(crosstablePlayers.map((p, i) => [p.id, i]));
  const crosstableRows: CrosstableRow[] = crosstablePlayers.map((p) => ({
    player: p,
    cells: crosstablePlayers.map((_, i) => (i === idxByPlayerId.get(p.id) ? null : { gamesWon: null, pairingId: null })),
    totalGamesWon: 0,
  }));
  for (const p of pairings) {
    const aIdx = idxByPlayerId.get(p.playerAId);
    const bIdx = idxByPlayerId.get(p.playerBId);
    if (aIdx === undefined || bIdx === undefined) continue;
    const aRow = crosstableRows[aIdx]!;
    const bRow = crosstableRows[bIdx]!;
    aRow.cells[bIdx] = { gamesWon: p.gamesWonA, pairingId: p.id };
    bRow.cells[aIdx] = { gamesWon: p.gamesWonB, pairingId: p.id };
    aRow.totalGamesWon += p.gamesWonA;
    bRow.totalGamesWon += p.gamesWonB;
  }

  return {
    division: {
      id: division.id,
      name: division.name,
      seasonId: division.seasonId,
      seasonName: division.season.name,
      tierName: division.tier.name,
      tierPosition: division.tier.position,
      activeCount: activeMembers.length,
      confirmedPairingCount: pairings.length,
    },
    standings,
    recentPairings,
    shootouts,
    unplayed,
    crosstable: { players: crosstablePlayers, rows: crosstableRows },
  };
}
