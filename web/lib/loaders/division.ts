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
import { formatSeasonLabel } from "@/lib/format-season";

export interface DivisionStandingRow {
  player: { id: string; displayName: string; discordId: string; username: string | null; rating: number | null };
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
  playerA: { id: string; displayName: string; discordId: string; username: string | null };
  playerB: { id: string; displayName: string; discordId: string; username: string | null };
  gamesWonA: number;
  gamesWonB: number;
  forfeit: boolean;
}

// One row per shootout in this division. Surfaced as its own list on
// the public page so readers can see how a tied pair was broken
// without having to dig through standings logic.
export interface DivisionShootout {
  id: string;
  recordedAt: Date;
  winner: { id: string; displayName: string; discordId: string; username: string | null };
  loser: { id: string; displayName: string; discordId: string; username: string | null };
  notes: string | null;
  selfReported: boolean;
}

export interface DivisionUnplayed {
  a: { id: string; displayName: string; discordId: string; username: string | null };
  b: { id: string; displayName: string; discordId: string; username: string | null };
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
}

const RECENT_PAIRINGS_LIMIT = 30;

export async function loadDivisionPageData(divisionId: string): Promise<DivisionPageData | null> {
  const division = await prisma.division.findFirst({
    where: { id: divisionId },
    select: {
      id: true,
      name: true,
      seasonId: true,
      tier: { select: { name: true, position: true } },
      season: { select: { number: true, subtitle: true, scheduleLocked: true } },
      members: {
        select: {
          playerId: true,
          status: true,
          player: { select: { id: true, displayName: true, discordId: true, username: true } },
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
    player: { id: r.player.id, displayName: r.player.displayName, discordId: r.player.discordId, username: r.player.username, rating: r.player.rating },
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

  const pairings = await prisma.match.findMany({
    where: { divisionId, status: "CONFIRMED", format: "LEAGUE_BO2" },
    select: {
      id: true,
      confirmedAt: true,
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
      forfeit: true,
      playerA: { select: { id: true, displayName: true, discordId: true, username: true } },
      playerB: { select: { id: true, displayName: true, discordId: true, username: true } },
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
      forfeit: p.forfeit,
    }));

  // Unplayed matchups across ACTIVE members. With a locked schedule (graph or
  // pre-created round-robin) only the ASSIGNED pairs are real matchups; with no
  // locked schedule it's a full round-robin (every not-yet-played pair).
  const playedKey = (a: string, b: string) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const playedSet = new Set(pairings.map((p) => playedKey(p.playerAId, p.playerBId)));
  // Load the pre-created schedule and treat the division as locked if it has any
  // 0-0 PENDING match — robust against a stale/false season.scheduleLocked flag.
  const scheduleMatches = await prisma.match.findMany({
    where: { divisionId, format: "LEAGUE_BO2" },
    select: { playerAId: true, playerBId: true, status: true, gamesWonA: true, gamesWonB: true },
  });
  const scheduleLocked =
    division.season.scheduleLocked ||
    scheduleMatches.some((m) => m.status === "PENDING" && m.gamesWonA === 0 && m.gamesWonB === 0);
  const assignedSet = new Set(scheduleMatches.map((p) => playedKey(p.playerAId, p.playerBId)));
  const unplayed: DivisionUnplayed[] = [];
  for (let i = 0; i < activeMembers.length; i++) {
    for (let j = i + 1; j < activeMembers.length; j++) {
      const a = activeMembers[i]!.player;
      const b = activeMembers[j]!.player;
      const key = playedKey(a.id, b.id);
      if (playedSet.has(key)) continue;
      if (scheduleLocked && !assignedSet.has(key)) continue; // not on the schedule
      unplayed.push({ a, b });
    }
  }

  // Shootouts — separate model from Pairing. We resolve the two players
  // through the active-member list (which is already loaded) so we
  // avoid an extra round trip per shootout.
  const memberById = new Map(division.members.map((m) => [m.playerId, m.player]));
  const rawShootouts = await prisma.match.findMany({
    where: { divisionId, format: "SHOOTOUT_BO1" },
    orderBy: { confirmedAt: "desc" },
  });
  const shootouts: DivisionShootout[] = rawShootouts.flatMap((s) => {
    const a = memberById.get(s.playerAId);
    const b = memberById.get(s.playerBId);
    if (!a || !b) return [];
    const winner = s.winnerId === a.id ? a : b;
    const loser = s.winnerId === a.id ? b : a;
    return [{
      id: s.id,
      recordedAt: s.confirmedAt ?? s.createdAt,
      winner,
      loser,
      notes: s.notes ?? null,
      selfReported: s.recordedBy === "self-report",
    }];
  });

  return {
    division: {
      id: division.id,
      name: division.name,
      seasonId: division.seasonId,
      seasonName: formatSeasonLabel(division.season),
      tierName: division.tier.name,
      tierPosition: division.tier.position,
      activeCount: activeMembers.length,
      confirmedPairingCount: pairings.length,
    },
    standings,
    recentPairings,
    shootouts,
    unplayed,
  };
}
