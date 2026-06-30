// A team's season view: roster (seeds, captain) + each player's set/game record
// that season, with team totals. Derived from the imported sets.
import { prisma } from "./db";
import { getSeasonStandings } from "./standings";

export interface TeamPlacement {
  placement: number; // 1-based rank within its conference group
  groupSize: number;
  conference: string;
  matchupsW: number;
  matchupsL: number;
}

// A team's final standing (placement within its conference) + matchup (week)
// record — DERIVED from getSeasonStandings (derive-on-read rule), not imported.
export async function getTeamPlacement(teamSeasonId: string, seasonName: string): Promise<TeamPlacement | null> {
  const st = await getSeasonStandings(seasonName);
  if (!st) return null;
  for (const g of st.groups) {
    const i = g.rows.findIndex((r) => r.teamSeasonId === teamSeasonId);
    if (i >= 0) {
      const r = g.rows[i];
      return { placement: i + 1, groupSize: g.rows.length, conference: g.conferenceName, matchupsW: r.matchupsW, matchupsL: r.matchupsL };
    }
  }
  return null;
}

// Placement + matchup record for every team-season (all seasons), for the LB.
export async function getTeamPlacements(): Promise<Map<string, TeamPlacement>> {
  const seasons = await prisma.tourSeason.findMany({ select: { name: true } });
  const map = new Map<string, TeamPlacement>();
  for (const s of seasons) {
    const st = await getSeasonStandings(s.name);
    if (!st) continue;
    for (const g of st.groups) {
      g.rows.forEach((r, i) => {
        map.set(r.teamSeasonId, { placement: i + 1, groupSize: g.rows.length, conference: g.conferenceName, matchupsW: r.matchupsW, matchupsL: r.matchupsL });
      });
    }
  }
  return map;
}

export interface TeamPlayerLine {
  playerId: string;
  name: string;
  seed: number;
  isCaptain: boolean;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
}

export interface TeamSeasonView {
  teamSeasonId: string;
  teamName: string;
  seasonName: string;
  conferenceName: string;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
  players: TeamPlayerLine[];
}

export interface TeamSeasonRow {
  teamSeasonId: string;
  teamName: string;
  seasonName: string;
  setW: number;
  setL: number;
  gameW: number;
  gameL: number;
  isChampion: boolean;
}

// All team-seasons ranked by set win % — the all-time team leaderboard.
export async function getAllTimeTeams(): Promise<TeamSeasonRow[]> {
  const teamSeasons = await prisma.teamSeason.findMany({
    include: { team: true, season: true, rosters: { include: { entries: true } } },
  });
  const tsByPlayerSeason = new Map<string, string>();
  const info = new Map<string, { teamName: string; seasonName: string }>();
  for (const ts of teamSeasons) {
    info.set(ts.id, { teamName: ts.team.name, seasonName: ts.season.name });
    for (const r of ts.rosters) for (const e of r.entries) tsByPlayerSeason.set(`${e.playerId}|${ts.seasonId}`, ts.id);
  }

  const sets = await prisma.tourSet.findMany({
    where: { seasonId: { not: null }, bracket: "REGULAR" }, // all-time team records = regular season
    select: { playerAId: true, playerBId: true, matchId: true, seasonId: true },
  });
  const matches = await prisma.match.findMany({
    where: { id: { in: sets.map((s) => s.matchId).filter((x): x is string => !!x) } },
    select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });
  const mById = new Map(matches.map((m) => [m.id, m]));

  const acc = new Map<string, { setW: number; setL: number; gameW: number; gameL: number }>();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = { setW: 0, setL: 0, gameW: 0, gameL: 0 };
      acc.set(id, a);
    }
    return a;
  };
  for (const s of sets) {
    const m = s.matchId ? mById.get(s.matchId) : undefined;
    if (!m) continue;
    for (const pid of [s.playerAId, s.playerBId]) {
      const tsId = tsByPlayerSeason.get(`${pid}|${s.seasonId}`);
      if (!tsId) continue;
      const a = get(tsId);
      const gFor = m.playerAId === pid ? m.gamesWonA : m.gamesWonB;
      const gAg = m.playerAId === pid ? m.gamesWonB : m.gamesWonA;
      a.gameW += gFor;
      a.gameL += gAg;
      if (m.winnerId === pid) a.setW++;
      else if (m.winnerId) a.setL++;
    }
  }

  const finals = await prisma.playoffSeries.findMany({
    where: { round: "FINAL", winnerTeamSeasonId: { not: null } },
    select: { winnerTeamSeasonId: true },
  });
  const champs = new Set(finals.map((f) => f.winnerTeamSeasonId));

  const rate = (w: number, l: number) => (w + l ? w / (w + l) : 0);
  return [...acc.entries()]
    .map(([id, a]) => ({
      teamSeasonId: id,
      teamName: info.get(id)?.teamName ?? id,
      seasonName: info.get(id)?.seasonName ?? "",
      ...a,
      isChampion: champs.has(id),
    }))
    .sort((x, y) => rate(y.setW, y.setL) - rate(x.setW, x.setL) || y.setW - x.setW);
}

export async function getTeamSeason(id: string): Promise<TeamSeasonView | null> {
  const ts = await prisma.teamSeason.findUnique({
    where: { id },
    include: { team: true, season: true, conference: true, rosters: { include: { entries: true } } },
  });
  if (!ts) return null;

  const entryByPlayer = new Map<string, { seed: number; isCaptain: boolean }>();
  for (const r of ts.rosters) {
    for (const e of r.entries) if (!entryByPlayer.has(e.playerId)) entryByPlayer.set(e.playerId, { seed: e.seed, isCaptain: e.isCaptain });
  }
  const playerIds = [...entryByPlayer.keys()];

  const [players, sets] = await Promise.all([
    prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } }),
    prisma.tourSet.findMany({
      where: { seasonId: ts.seasonId, bracket: "REGULAR", OR: [{ playerAId: { in: playerIds } }, { playerBId: { in: playerIds } }] },
      select: { playerAId: true, playerBId: true, matchId: true },
    }),
  ]);
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));
  const matches = await prisma.match.findMany({
    where: { id: { in: sets.map((s) => s.matchId).filter((x): x is string => !!x) } },
    select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });
  const mById = new Map(matches.map((m) => [m.id, m]));

  const acc = new Map<string, { setW: number; setL: number; gameW: number; gameL: number }>();
  const get = (pid: string) => {
    let a = acc.get(pid);
    if (!a) {
      a = { setW: 0, setL: 0, gameW: 0, gameL: 0 };
      acc.set(pid, a);
    }
    return a;
  };
  for (const s of sets) {
    const m = s.matchId ? mById.get(s.matchId) : undefined;
    if (!m) continue;
    for (const pid of [s.playerAId, s.playerBId]) {
      if (!entryByPlayer.has(pid)) continue;
      const a = get(pid);
      const gFor = m.playerAId === pid ? m.gamesWonA : m.gamesWonB;
      const gAg = m.playerAId === pid ? m.gamesWonB : m.gamesWonA;
      a.gameW += gFor;
      a.gameL += gAg;
      if (m.winnerId === pid) a.setW++;
      else if (m.winnerId) a.setL++;
    }
  }

  const playerLines: TeamPlayerLine[] = playerIds
    .map((pid) => {
      const e = entryByPlayer.get(pid)!;
      const a = acc.get(pid) ?? { setW: 0, setL: 0, gameW: 0, gameL: 0 };
      return { playerId: pid, name: nameById.get(pid) ?? pid, seed: e.seed, isCaptain: e.isCaptain, ...a };
    })
    .sort((x, y) => x.seed - y.seed);

  const tot = playerLines.reduce(
    (t, p) => ({ setW: t.setW + p.setW, setL: t.setL + p.setL, gameW: t.gameW + p.gameW, gameL: t.gameL + p.gameL }),
    { setW: 0, setL: 0, gameW: 0, gameL: 0 },
  );

  return {
    teamSeasonId: ts.id,
    teamName: ts.team.name,
    seasonName: ts.season.name,
    conferenceName: ts.conference.name,
    ...tot,
    players: playerLines,
  };
}
