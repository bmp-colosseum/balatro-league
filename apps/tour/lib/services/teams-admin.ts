// Admin team management: list every team-season with its footprint, and force-delete
// one (with all its references) — for cleaning up stale/phantom/mis-parsed teams that the
// import's upsert-by-name never removes. Centralized service; the admin page/action only
// call these. Destructive: the action is admin-gated + confirmed.
import { prisma } from "../db";

export interface AdminTeamRow {
  teamSeasonId: string;
  teamId: string;
  team: string;
  season: string;
  players: number;
  sets: number;
  series: number;
}

// Every team-season with how much real data hangs off it, so an admin can spot phantoms
// (0 players, 0 sets) vs real teams.
export async function listTeamsAdmin(): Promise<AdminTeamRow[]> {
  const tss = await prisma.teamSeason.findMany({ include: { team: true, season: { select: { name: true } } } });
  const rows: AdminTeamRow[] = [];
  for (const ts of tss) {
    const [players, sets, series] = await Promise.all([
      prisma.rosterEntry.count({ where: { roster: { teamSeasonId: ts.id } } }),
      prisma.tourSet.count({ where: { OR: [{ teamSeasonAId: ts.id }, { teamSeasonBId: ts.id }] } }),
      prisma.playoffSeries.count({ where: { OR: [{ teamSeasonAId: ts.id }, { teamSeasonBId: ts.id }] } }),
    ]);
    rows.push({ teamSeasonId: ts.id, teamId: ts.teamId, team: ts.team.name, season: ts.season.name, players, sets, series });
  }
  return rows.sort((a, b) => a.season.localeCompare(b.season) || a.team.localeCompare(b.team));
}

// Force-delete a team-season and everything that references it (sets + their matches,
// playoff series, draft picks, roster moves, rival pointers; rosters/entries cascade via
// FK), then the Team itself if it has no seasons left. Returns what was removed.
export async function deleteTeamSeason(teamSeasonId: string): Promise<{ team: string; setsDeleted: number }> {
  if (!teamSeasonId) throw new Error("No team selected.");
  const ts = await prisma.teamSeason.findUnique({ where: { id: teamSeasonId }, include: { team: true } });
  if (!ts) throw new Error("No such team-season.");

  const sets = await prisma.tourSet.findMany({
    where: { OR: [{ teamSeasonAId: teamSeasonId }, { teamSeasonBId: teamSeasonId }] },
    select: { id: true, matchId: true },
  });
  if (sets.length) {
    await prisma.tourSet.deleteMany({ where: { id: { in: sets.map((s) => s.id) } } });
    const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
    if (matchIds.length) await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
  }
  await prisma.playoffSeries.deleteMany({ where: { OR: [{ teamSeasonAId: teamSeasonId }, { teamSeasonBId: teamSeasonId }] } });
  await prisma.draftPick.deleteMany({ where: { teamSeasonId } });
  await prisma.rosterMove.deleteMany({ where: { teamSeasonId } });
  await prisma.teamSeason.updateMany({ where: { rivalTeamSeasonId: teamSeasonId }, data: { rivalTeamSeasonId: null } });
  await prisma.teamSeason.delete({ where: { id: teamSeasonId } }); // cascades rosters + entries

  const remaining = await prisma.teamSeason.count({ where: { teamId: ts.teamId } });
  if (remaining === 0) await prisma.team.delete({ where: { id: ts.teamId } });
  return { team: ts.team.name, setsDeleted: sets.length };
}
