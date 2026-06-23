// Loaders for the public seasons surfaces:
//   loadSeasonsIndex()   — /seasons (list of non-archived ended seasons)
//   loadSeasonDetail(id) — /seasons/[id] (detail with tiers + divisions +
//                          cached standings rows per division)
//
// "Public visibility" filtering used to live here as a per-row flag; with
// a dedicated dev stack that's gone. Players see seasons that are either
// active OR have ended. Pre-start drafts stay hidden because they have
// neither isActive nor endedAt set.

import { prisma } from "@/lib/prisma";
import { loadManyDivisionStandings } from "@/lib/standings-cache";
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
  // Every real (non-archived) season players can browse: the ACTIVE one plus all
  // ENDED ones. Pre-start drafts (neither active nor ended) stay hidden because
  // they're not real yet. The orderBy below puts the active season first.
  const seasons = await prisma.season.findMany({
    where: { archivedAt: null, OR: [{ isActive: true }, { endedAt: { not: null } }] },
    select: {
      id: true,
      number: true,
      subtitle: true,
      isActive: true,
      startedAt: true,
      endedAt: true,
      _count: { select: { divisions: true } },
      divisions: { select: { _count: { select: { members: true, matches: { where: { format: "LEAGUE_BO2" } } } } } },
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
    pairingCount: s.divisions.reduce((sum, d) => sum + d._count.matches, 0),
  }));
}

export interface SeasonDetailStandingRow {
  player: { id: string; displayName: string; discordId: string; username: string | null };
  points: number;
  wins: number;
  draws: number;
  losses: number;
  played: number;
  gamesWon: number;
  gamesLost: number;
  dropped: boolean;
  // Set when the season has been ended (computed by computeRatingDeltas
  // + written by endSeason). Null while the season is in-progress.
  finalGlobalRank: number | null;
  // Live standings rank (ties shared) for in-progress display.
  rank?: number;
  tiedWithPrev?: boolean;
  tiedWithNext?: boolean;
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
  promoteRelegateCount: number;
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
  // 404 drafts publicly — only active + ended seasons are addressable.
  const season = await prisma.season.findFirst({
    where: { id: seasonId, OR: [{ isActive: true }, { endedAt: { not: null } }] },
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
          promoteRelegateCount: true,
          divisions: {
            orderBy: { groupNumber: "asc" },
            select: {
              id: true,
              name: true,
              groupNumber: true,
              members: { select: { playerId: true, status: true, finalGlobalRank: true } },
            },
          },
        },
      },
    },
  });
  if (!season) return null;

  // Cached standings for every division — two queries total (batched cache
  // read + batched player hydration) rather than two per division.
  const allDivIds = season.tiers.flatMap((t) => t.divisions.map((d) => d.id));
  const byDiv = await loadManyDivisionStandings(allDivIds);

  const tiers: SeasonDetailTier[] = season.tiers.map((t) => ({
    id: t.id,
    name: t.name,
    position: t.position,
    promoteRelegateCount: t.promoteRelegateCount,
    divisions: t.divisions.map((d) => {
      const droppedIds = new Set(
        d.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
      );
      const finalRankByPlayer = new Map(
        d.members.map((m) => [m.playerId, m.finalGlobalRank]),
      );
      const rows = (byDiv.get(d.id) ?? []).map((r): SeasonDetailStandingRow => ({
        player: { id: r.player.id, displayName: r.player.displayName, discordId: r.player.discordId, username: r.player.username },
        points: r.points,
        wins: r.wins,
        draws: r.draws,
        losses: r.losses,
        played: r.played,
        gamesWon: r.gamesWon,
        gamesLost: r.gamesLost,
        dropped: droppedIds.has(r.player.id),
        finalGlobalRank: finalRankByPlayer.get(r.player.id) ?? null,
        rank: r.rank,
        tiedWithPrev: r.tiedWithPrev,
        tiedWithNext: r.tiedWithNext,
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
