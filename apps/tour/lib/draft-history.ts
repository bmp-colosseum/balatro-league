// Read model for a season's draft board (from imported Draft/DraftPick). Each team
// = its captain (seed 1) + the players it drafted, in round order.
import { prisma } from "@/lib/db";

export interface DraftTeam {
  teamSeasonId: string;
  teamName: string;
  conference: string;
  seed: number;
  captainName: string;
  captainId: string;
  picks: { round: number; playerId: string; name: string }[];
}

export async function getSeasonDraft(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    include: { draft: { select: { id: true, state: true } } },
  });
  if (!season || !season.draft) return null;

  const [picks, teamSeasons] = await Promise.all([
    prisma.draftPick.findMany({ where: { draftId: season.draft.id }, orderBy: { round: "asc" } }),
    prisma.teamSeason.findMany({
      where: { seasonId: season.id },
      include: { team: true, conference: true },
      orderBy: { seed: "asc" },
    }),
  ]);

  const playerIds = [
    ...new Set([
      ...picks.map((p) => p.playerId).filter((x): x is string => !!x),
      ...teamSeasons.map((t) => t.captainPlayerId),
    ]),
  ];
  const players = await prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));

  const teams: DraftTeam[] = teamSeasons.map((ts) => ({
    teamSeasonId: ts.id,
    teamName: ts.team.name,
    conference: ts.conference.name,
    seed: ts.seed,
    captainName: nameOf.get(ts.captainPlayerId) ?? ts.captainPlayerId,
    captainId: ts.captainPlayerId,
    picks: picks
      .filter((p) => p.teamSeasonId === ts.id && p.playerId)
      .sort((a, b) => a.round - b.round)
      .map((p) => ({ round: p.round, playerId: p.playerId!, name: nameOf.get(p.playerId!) ?? p.playerId! })),
  }));

  const conferences = [...new Set(teams.map((t) => t.conference))];
  return { seasonName: season.name, teams, rounds: Math.max(0, ...teams.map((t) => t.picks.length)), conferences };
}

export interface PlayerDraftLine {
  season: string;
  team: string;
  round: number; // 0 = captain (not drafted)
  isCaptain: boolean;
}

// A player's draft position each season — drafted in round N by a team, or a
// captain (seed 1, not drafted). Sorted by season number.
export async function getPlayerDrafts(playerId: string): Promise<PlayerDraftLine[]> {
  const [picks, captaincies] = await Promise.all([
    prisma.draftPick.findMany({
      where: { playerId },
      include: { draft: { select: { season: { select: { name: true } } } } },
    }),
    prisma.teamSeason.findMany({
      where: { captainPlayerId: playerId }, // any season they captained
      include: { team: true, season: { select: { name: true } } },
    }),
  ]);

  const teamSeasons = await prisma.teamSeason.findMany({
    where: { id: { in: picks.map((p) => p.teamSeasonId) } },
    include: { team: true },
  });
  const teamOf = new Map(teamSeasons.map((t) => [t.id, t.team.name]));

  const lines: PlayerDraftLine[] = [
    ...captaincies.map((c) => ({ season: c.season.name, team: c.team.name, round: 0, isCaptain: true })),
    ...picks.map((p) => ({ season: p.draft.season.name, team: teamOf.get(p.teamSeasonId) ?? "?", round: p.round, isCaptain: false })),
  ];
  const num = (s: string) => Number(s.match(/(\d+)/)?.[1] ?? 0);
  return lines.sort((a, b) => num(a.season) - num(b.season));
}
