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

export interface DivisionUnplayed {
  a: { id: string; displayName: string };
  b: { id: string; displayName: string };
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
  unplayed: DivisionUnplayed[];
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
    unplayed,
  };
}
