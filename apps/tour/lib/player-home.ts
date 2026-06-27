// The signed-in player's personal view: their team(s) this/last season and their
// per-week set assignments (opponent + status + score). Derive-on-read over
// RosterEntry membership + matchup-linked TourSets. Keyed by core Player.id.
import { prisma } from "./db";

const num = (s: string) => Number(s.match(/(\d+)/)?.[1] ?? 0);
const ACTIVE_STATES = ["SIGNUPS", "DRAFTING", "REGULAR", "PLAYOFFS"];

export interface MySet {
  setId: string;
  week: number;
  opponentName: string;
  status: string;
  myGames: number | null;
  oppGames: number | null;
  result: "won" | "lost" | "tie" | null;
}

export interface MyTeam {
  teamSeasonId: string;
  teamName: string;
  seasonName: string;
  state: string;
  active: boolean;
  seed: number;
  isCaptain: boolean;
}

export interface PlayerHome {
  teams: MyTeam[];
  sets: MySet[]; // for the most relevant (active, else latest) season, by week
  focusSeason: string | null;
}

export async function getPlayerHome(playerId: string): Promise<PlayerHome> {
  // Team memberships → team-seasons.
  const entries = await prisma.rosterEntry.findMany({
    where: { playerId },
    include: { roster: { include: { teamSeason: { include: { team: true, season: true } } } } },
  });
  const teamMap = new Map<string, MyTeam>();
  for (const e of entries) {
    const ts = e.roster.teamSeason;
    if (!teamMap.has(ts.id)) {
      teamMap.set(ts.id, {
        teamSeasonId: ts.id,
        teamName: ts.team.name,
        seasonName: ts.season.name,
        state: ts.season.state,
        active: ACTIVE_STATES.includes(ts.season.state),
        seed: e.seed,
        isCaptain: e.isCaptain || ts.captainPlayerId === playerId,
      });
    }
  }
  const teams = [...teamMap.values()].sort((a, b) => num(b.seasonName) - num(a.seasonName));
  const focus = teams.find((t) => t.active) ?? teams[0] ?? null;

  // My matchup-linked sets in the focus season.
  let sets: MySet[] = [];
  if (focus) {
    const focusSeason = await prisma.tourSeason.findUnique({ where: { name: focus.seasonName }, select: { id: true } });
    const rows = await prisma.tourSet.findMany({
      where: { matchupId: { not: null }, OR: [{ playerAId: playerId }, { playerBId: playerId }], matchup: { week: { seasonId: focusSeason?.id } } },
      include: { matchup: { include: { week: { select: { number: true } } } } },
    });
    const matchIds = rows.map((r) => r.matchId).filter((x): x is string => !!x);
    const oppIds = [...new Set(rows.map((r) => (r.playerAId === playerId ? r.playerBId : r.playerAId)))];
    const [matches, players] = await Promise.all([
      prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }),
      prisma.player.findMany({ where: { id: { in: oppIds } }, select: { id: true, displayName: true } }),
    ]);
    const mById = new Map(matches.map((m) => [m.id, m]));
    const nameOf = new Map(players.map((p) => [p.id, p.displayName]));

    sets = rows
      .map((r): MySet => {
        const oppId = r.playerAId === playerId ? r.playerBId : r.playerAId;
        const m = r.matchId ? mById.get(r.matchId) : undefined;
        let myGames: number | null = null;
        let oppGames: number | null = null;
        let result: MySet["result"] = null;
        if (m) {
          myGames = m.playerAId === playerId ? m.gamesWonA : m.gamesWonB;
          oppGames = m.playerAId === playerId ? m.gamesWonB : m.gamesWonA;
          result = m.winnerId === playerId ? "won" : m.winnerId === oppId ? "lost" : "tie";
        }
        return { setId: r.id, week: r.matchup?.week.number ?? 0, opponentName: nameOf.get(oppId) ?? "?", status: r.status, myGames, oppGames, result };
      })
      .sort((a, b) => a.week - b.week);
  }

  return { teams, sets, focusSeason: focus?.seasonName ?? null };
}
