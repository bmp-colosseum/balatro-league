// Season-end service (B9). Crowns the playoff champion (writes a Championship +
// advances the season to DONE) and surfaces the season's awards for the end page.
// The FINAL series winner from B8 is the champion; awards are created/managed by the
// TO via lib/services/awards.ts (preset kinds or custom, multi-slot).
import { prisma } from "../db";
import { loadSeasonAwards } from "../awards";

export async function getSeasonEnd(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, name: true, state: true } });
  if (!season) return null;

  const [finalSeries, championship, teamSeasons, awards] = await Promise.all([
    prisma.playoffSeries.findFirst({ where: { seasonId: season.id, round: "FINAL" } }),
    prisma.championship.findFirst({ where: { seasonId: season.id } }),
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: true, rosters: { include: { entries: true } } } }),
    loadSeasonAwards(season.id),
  ]);

  const teamName = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const teamOptions = teamSeasons
    .map((t) => ({ teamId: t.teamId, name: t.team.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const playerIds = [...new Set(teamSeasons.flatMap((t) => [t.captainPlayerId, ...t.rosters.flatMap((r) => r.entries.map((e) => e.playerId))]))];
  const players = await prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } });
  const playerOptions = players.map((p) => ({ id: p.id, name: p.displayName })).sort((a, b) => a.name.localeCompare(b.name));

  const championTeamName = championship
    ? teamSeasons.find((t) => t.teamId === championship.teamId)?.team.name ?? null
    : finalSeries?.winnerTeamSeasonId
      ? teamName.get(finalSeries.winnerTeamSeasonId) ?? null
      : null;

  return {
    seasonName: season.name,
    state: season.state,
    finalDecided: !!finalSeries?.winnerTeamSeasonId,
    crowned: !!championship,
    championTeamName,
    playerOptions,
    teamOptions,
    awards,
  };
}

// Crown the FINAL winner: write the Championship (season-spanning Team) and move
// the season to DONE.
export async function crownChampion(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  const finalSeries = await prisma.playoffSeries.findFirst({ where: { seasonId: season.id, round: "FINAL" } });
  if (!finalSeries?.winnerTeamSeasonId) throw new Error("The FINAL isn't decided yet — finish the bracket first.");
  const ts = await prisma.teamSeason.findUnique({ where: { id: finalSeries.winnerTeamSeasonId }, select: { teamId: true } });
  if (!ts) throw new Error("Champion team not found.");

  const existing = await prisma.championship.findFirst({ where: { seasonId: season.id } });
  if (existing) await prisma.championship.update({ where: { id: existing.id }, data: { teamId: ts.teamId } });
  else await prisma.championship.create({ data: { seasonId: season.id, teamId: ts.teamId } });

  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "DONE" } });
  return { ok: true };
}

// Undo the crown: drop the Championship and return the season to PLAYOFFS.
export async function uncrownChampion(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  await prisma.championship.deleteMany({ where: { seasonId: season.id } });
  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "PLAYOFFS" } });
}
