// Derive a season's team standings from the imported sets, using the generic
// competition-core engine + the Tour §5 tiebreaker chain. Server-only (reads DB).
import { computeStandings, type ContestResult, type Participant } from "@balatro/competition-core";
import { TOUR_TIEBREAKERS } from "@balatro/tour-core";
import { prisma } from "./db";

export interface TeamRow {
  teamSeasonId: string;
  name: string;
  matchupsW: number;
  matchupsL: number;
  setsW: number;
  setsL: number;
  gamesW: number;
  gamesL: number;
}

export interface SeasonStandings {
  seasonName: string;
  format: string;
  conferenceCount: number;
  playoffTeams: number;
  setCount: number;
  groups: { conferenceId: string; conferenceName: string; rows: TeamRow[] }[];
}

export async function getSeasonStandings(seasonName: string): Promise<SeasonStandings | null> {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    include: {
      conferences: true,
      teamSeasons: { include: { team: true, rosters: { include: { entries: true } } } },
    },
  });
  if (!season) return null;
  const confNameById = new Map(season.conferences.map((c) => [c.id, c.name]));

  const teamOfPlayer = new Map<string, string>();
  const teamName = new Map<string, string>();
  const confOfTeam = new Map<string, string>();
  const participants: Participant[] = [];
  for (const ts of season.teamSeasons) {
    teamName.set(ts.id, ts.team.name);
    confOfTeam.set(ts.id, ts.conferenceId);
    participants.push({ id: ts.id, groupId: ts.conferenceId });
    for (const r of ts.rosters) for (const e of r.entries) teamOfPlayer.set(e.playerId, ts.id);
  }

  // Prefer stored team-level matchup results (imported team-only seasons, e.g.
  // the conference season); otherwise derive from per-set player data grouped into team matchups.
  const storedMatchups = await prisma.matchup.findMany({
    where: { week: { seasonId: season.id }, setsWonA: { not: null } },
    select: {
      teamSeasonAId: true,
      teamSeasonBId: true,
      setsWonA: true,
      setsWonB: true,
      gamesWonA: true,
      gamesWonB: true,
      winnerTeamSeasonId: true,
    },
  });

  const results: ContestResult[] = [];
  let setCount = 0;

  if (storedMatchups.length > 0) {
    for (const mu of storedMatchups) {
      const sA = mu.setsWonA ?? 0;
      const sB = mu.setsWonB ?? 0;
      setCount += sA + sB;
      const outcome: "HOME" | "AWAY" | "DRAW" =
        mu.winnerTeamSeasonId === mu.teamSeasonAId ? "HOME" : mu.winnerTeamSeasonId === mu.teamSeasonBId ? "AWAY" : "DRAW";
      const matchups: [number, number] = outcome === "HOME" ? [1, 0] : outcome === "AWAY" ? [0, 1] : [0, 0];
      results.push({
        homeId: mu.teamSeasonAId,
        awayId: mu.teamSeasonBId,
        groupId: confOfTeam.get(mu.teamSeasonAId),
        outcome,
        metrics: { matchups, sets: [sA, sB], games: [mu.gamesWonA ?? 0, mu.gamesWonB ?? 0] },
      });
    }
  } else {
    const sets = await prisma.tourSet.findMany({
      where: { seasonId: season.id, bracket: "REGULAR" }, // standings = regular season only
      select: { playerAId: true, playerBId: true, matchId: true },
    });
    setCount = sets.length;
    const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
    const matches = await prisma.match.findMany({
      where: { id: { in: matchIds } },
      select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true },
    });
    const matchById = new Map(matches.map((m) => [m.id, m]));

    const pair = new Map<string, { x: string; y: string; setsX: number; setsY: number; gamesX: number; gamesY: number }>();
    for (const s of sets) {
      const tA = teamOfPlayer.get(s.playerAId);
      const tB = teamOfPlayer.get(s.playerBId);
      const m = s.matchId ? matchById.get(s.matchId) : undefined;
      if (!tA || !tB || tA === tB || !m) continue;
      const gA = m.playerAId === s.playerAId ? m.gamesWonA : m.gamesWonB;
      const gB = m.playerAId === s.playerAId ? m.gamesWonB : m.gamesWonA;
      const [x, y] = tA < tB ? [tA, tB] : [tB, tA];
      const key = `${x}|${y}`;
      let a = pair.get(key);
      if (!a) {
        a = { x, y, setsX: 0, setsY: 0, gamesX: 0, gamesY: 0 };
        pair.set(key, a);
      }
      const gX = tA === x ? gA : gB;
      const gY = tA === x ? gB : gA;
      a.gamesX += gX;
      a.gamesY += gY;
      const w = gA > gB ? tA : gB > gA ? tB : null;
      if (w === x) a.setsX++;
      else if (w === y) a.setsY++;
    }
    for (const a of pair.values()) {
      const outcome: "HOME" | "AWAY" | "DRAW" = a.setsX > a.setsY ? "HOME" : a.setsY > a.setsX ? "AWAY" : "DRAW";
      const matchups: [number, number] = outcome === "HOME" ? [1, 0] : outcome === "AWAY" ? [0, 1] : [0, 0];
      results.push({
        homeId: a.x,
        awayId: a.y,
        groupId: confOfTeam.get(a.x),
        outcome,
        metrics: { matchups, sets: [a.setsX, a.setsY], games: [a.gamesX, a.gamesY] },
      });
    }
  }

  const standings = computeStandings(participants, results, { tiebreakers: TOUR_TIEBREAKERS });
  const groups: SeasonStandings["groups"] = [];
  for (const [conferenceId, rows] of standings) {
    groups.push({
      conferenceId,
      conferenceName: confNameById.get(conferenceId) ?? conferenceId,
      rows: rows.map((r) => {
        const mr = r.metrics.matchups ?? { for: 0, against: 0 };
        const sr = r.metrics.sets ?? { for: 0, against: 0 };
        const gr = r.metrics.games ?? { for: 0, against: 0 };
        return {
          teamSeasonId: r.participantId,
          name: teamName.get(r.participantId) ?? r.participantId,
          matchupsW: mr.for,
          matchupsL: mr.against,
          setsW: sr.for,
          setsL: sr.against,
          gamesW: gr.for,
          gamesL: gr.against,
        };
      }),
    });
  }
  return {
    seasonName: season.name,
    format: season.format,
    conferenceCount: season.conferenceCount,
    playoffTeams: season.playoffTeams,
    setCount,
    groups,
  };
}
