// Loaders for the public seasons surfaces:
//   loadSeasonsIndex()   — /seasons (list of non-archived public seasons)
//   loadSeasonDetail(id) — /seasons/[id] (detail with tiers + divisions +
//                          cached standings rows per division)

import { prisma } from "@/lib/prisma";
import { loadDivisionStandings } from "@/lib/standings-cache";
import { formatSeasonLabel } from "@/lib/format-season";

export interface SeasonIndexEntry {
  id: string;
  name: string;
  isActive: boolean;
  startedAt: Date;
  endedAt: Date | null;
  divisionCount: number;
  playerCount: number;
  pairingCount: number;
}

export async function loadSeasonsIndex(): Promise<SeasonIndexEntry[]> {
  const seasons = await prisma.season.findMany({
    where: { visibility: "PUBLIC", archivedAt: null },
    select: {
      id: true,
      number: true,
      subtitle: true,
      isActive: true,
      startedAt: true,
      endedAt: true,
      _count: { select: { divisions: true } },
      divisions: { select: { _count: { select: { members: true, pairings: true } } } },
    },
    orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
  });
  return seasons.map((s) => ({
    id: s.id,
    name: formatSeasonLabel(s),
    isActive: s.isActive,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    divisionCount: s._count.divisions,
    playerCount: s.divisions.reduce((sum, d) => sum + d._count.members, 0),
    pairingCount: s.divisions.reduce((sum, d) => sum + d._count.pairings, 0),
  }));
}

export interface SeasonDetailStandingRow {
  player: { id: string; displayName: string };
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  dropped: boolean;
}

export interface SeasonDetailDivision {
  id: string;
  name: string;
  groupNumber: number;
  rows: SeasonDetailStandingRow[];
}

export interface SeasonDetailTier {
  id: string;
  name: string;
  position: number;
  divisions: SeasonDetailDivision[];
}

export interface SeasonDetailData {
  id: string;
  name: string;
  isActive: boolean;
  startedAt: Date;
  endedAt: Date | null;
  tiers: SeasonDetailTier[];
}

export async function loadSeasonDetail(seasonId: string): Promise<SeasonDetailData | null> {
  const season = await prisma.season.findFirst({
    where: { id: seasonId, visibility: "PUBLIC" },
    select: {
      id: true,
      number: true,
      subtitle: true,
      isActive: true,
      startedAt: true,
      endedAt: true,
      tiers: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          name: true,
          position: true,
          divisions: {
            orderBy: { groupNumber: "asc" },
            select: {
              id: true,
              name: true,
              groupNumber: true,
              members: { select: { playerId: true, status: true } },
            },
          },
        },
      },
    },
  });
  if (!season) return null;

  // Cached standings for every division in parallel.
  const allDivIds = season.tiers.flatMap((t) => t.divisions.map((d) => d.id));
  const standingsRows = await Promise.all(
    allDivIds.map(async (id) => [id, await loadDivisionStandings(id)] as const),
  );
  const byDiv = new Map(standingsRows);

  const tiers: SeasonDetailTier[] = season.tiers.map((t) => ({
    id: t.id,
    name: t.name,
    position: t.position,
    divisions: t.divisions.map((d) => {
      const droppedIds = new Set(
        d.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
      );
      const rows = (byDiv.get(d.id) ?? []).map((r): SeasonDetailStandingRow => ({
        player: { id: r.player.id, displayName: r.player.displayName },
        points: r.points,
        wins: r.wins,
        draws: r.draws,
        losses: r.losses,
        gamesWon: r.gamesWon,
        gamesLost: r.gamesLost,
        dropped: droppedIds.has(r.player.id),
      }));
      return { id: d.id, name: d.name, groupNumber: d.groupNumber, rows };
    }),
  }));

  return {
    id: season.id,
    name: formatSeasonLabel(season),
    isActive: season.isActive,
    startedAt: season.startedAt,
    endedAt: season.endedAt,
    tiers,
  };
}
