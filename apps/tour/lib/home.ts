// Home overview: each season with its champion, team count, and format.
import { prisma } from "./db";

export interface SeasonCard {
  name: string;
  format: string;
  teams: number;
  champion: string | null;
  championTeamSeasonId: string | null;
}

export async function getSeasonsOverview(): Promise<SeasonCard[]> {
  const [seasons, finals] = await Promise.all([
    prisma.tourSeason.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { teamSeasons: true } } } }),
    prisma.playoffSeries.findMany({
      where: { round: "FINAL", winnerTeamSeasonId: { not: null } },
      select: { seasonId: true, winnerTeamSeasonId: true },
    }),
  ]);
  const champTsIds = finals.map((f) => f.winnerTeamSeasonId).filter((x): x is string => !!x);
  const champTeams = await prisma.teamSeason.findMany({ where: { id: { in: champTsIds } }, include: { team: true } });
  const nameByTs = new Map(champTeams.map((t) => [t.id, t.team.name]));
  const champBySeason = new Map(finals.map((f) => [f.seasonId, f.winnerTeamSeasonId ? nameByTs.get(f.winnerTeamSeasonId) ?? null : null]));
  const champTsBySeason = new Map(finals.map((f) => [f.seasonId, f.winnerTeamSeasonId ?? null]));

  return seasons.map((s) => ({
    name: s.name,
    format: s.format,
    teams: s._count.teamSeasons,
    champion: champBySeason.get(s.id) ?? null,
    championTeamSeasonId: champTsBySeason.get(s.id) ?? null,
  }));
}
