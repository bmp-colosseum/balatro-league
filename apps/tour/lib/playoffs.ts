// The champion's playoff run for a season (Hall of Fame). Handles two shapes:
//   • Historical imports — only the winner's path is recorded (QF→SF→Final), with
//     the champion stored as teamSeasonA in every row (no PlayoffEntry).
//   • Live B8 brackets — a full single-elim bracket (PlayoffEntry seeds + every
//     series). The champion is the crowned team (Championship) or the FINAL winner;
//     the run is the series the champion actually played.
import { prisma } from "./db";

const ROUND_ORDER: Record<string, number> = { QUARTERFINAL: 0, SEMIFINAL: 1, FINAL: 2 };
const ROUND_LABEL: Record<string, string> = {
  QUARTERFINAL: "Quarterfinal",
  SEMIFINAL: "Semifinal",
  FINAL: "Final",
};

export interface BracketSeries {
  round: string;
  label: string;
  aSeed: number | null;
  aName: string;
  aTeamSeasonId: string | null;
  bSeed: number | null;
  bName: string;
  bTeamSeasonId: string | null;
  scoreA: number | null;
  scoreB: number | null;
  winner: "A" | "B" | null;
  decided: boolean;
  sets: BracketSet[]; // the player sets within this series (for the expand view)
}

// A player set inside a series, oriented so A = team A's player.
export interface BracketSet {
  playerA: string;
  playerAId: string;
  scoreA: number;
  playerB: string;
  playerBId: string;
  scoreB: number;
  winner: "A" | "B" | null;
}

export interface PublicBracket {
  champion: string | null;
  championTeamSeasonId: string | null;
  rounds: { round: string; label: string; series: BracketSeries[] }[];
}

// The full single-elim bracket for a season — every recorded series grouped by round.
// Live B8 seasons carry PlayoffEntry seeds; historical imports store the whole bracket
// too (just without seeds). Returns null only when no series exist (→ page projects).
export async function getPublicBracket(seasonName: string): Promise<PublicBracket | null> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) return null;
  const series = await prisma.playoffSeries.findMany({ where: { seasonId: season.id }, orderBy: { bracketIndex: "asc" } });
  if (series.length === 0) return null; // no bracket recorded → page falls back to projection
  // Live B8 seasons have PlayoffEntry seeds; historical imports don't (seeds show as blank).
  const entries = await prisma.playoffEntry.findMany({ where: { seasonId: season.id } });
  const tsIds = [...new Set([...entries.map((e) => e.teamSeasonId), ...series.flatMap((s) => [s.teamSeasonAId, s.teamSeasonBId])].filter((x): x is string => !!x))];
  const teamSeasons = await prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: true } });
  const nameOf = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const seedOf = new Map(entries.map((e) => [e.teamSeasonId, e.seed]));

  // Player sets within each series — a playoff set's two players tell us which teams met
  // (via their season rosters), so group the season's PLAYOFF sets by unordered team pair.
  const poSets = await prisma.tourSet.findMany({ where: { seasonId: season.id, bracket: "PLAYOFF" }, select: { playerAId: true, playerBId: true, matchId: true } });
  const rEntries = await prisma.rosterEntry.findMany({ where: { roster: { teamSeason: { seasonId: season.id } } }, select: { playerId: true, roster: { select: { teamSeasonId: true } } } });
  const teamOfPlayer = new Map(rEntries.map((e) => [e.playerId, e.roster.teamSeasonId]));
  const poMatchIds = poSets.map((s) => s.matchId).filter((x): x is string => !!x);
  const poPids = [...new Set(poSets.flatMap((s) => [s.playerAId, s.playerBId]))];
  const [poMatches, poPlayers] = await Promise.all([
    prisma.match.findMany({ where: { id: { in: poMatchIds } }, select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true, winnerId: true } }),
    prisma.player.findMany({ where: { id: { in: poPids } }, select: { id: true, displayName: true } }),
  ]);
  const poMatchById = new Map(poMatches.map((m) => [m.id, m]));
  const poName = new Map(poPlayers.map((p) => [p.id, p.displayName]));
  const pairKey = (x: string, y: string) => [x, y].sort().join("|");
  const setsByPair = new Map<string, BracketSet[]>();
  for (const s of poSets) {
    const tA = teamOfPlayer.get(s.playerAId), tB = teamOfPlayer.get(s.playerBId);
    const m = s.matchId ? poMatchById.get(s.matchId) : undefined;
    if (!tA || !tB || !m) continue;
    (setsByPair.get(pairKey(tA, tB)) ?? setsByPair.set(pairKey(tA, tB), []).get(pairKey(tA, tB))!).push({
      playerA: poName.get(s.playerAId) ?? "?", playerAId: s.playerAId,
      playerB: poName.get(s.playerBId) ?? "?", playerBId: s.playerBId,
      scoreA: m.playerAId === s.playerAId ? m.gamesWonA : m.gamesWonB,
      scoreB: m.playerAId === s.playerAId ? m.gamesWonB : m.gamesWonA,
      winner: m.winnerId === s.playerAId ? "A" : m.winnerId === s.playerBId ? "B" : null,
    });
  }
  // orient a pair's sets so A = the series' team A
  const setsFor = (tsA: string | null, tsB: string | null): BracketSet[] => {
    if (!tsA || !tsB) return [];
    return (setsByPair.get(pairKey(tsA, tsB)) ?? []).map((st) => {
      const aIsTeamA = teamOfPlayer.get(st.playerAId) === tsA;
      return aIsTeamA ? st : { playerA: st.playerB, playerAId: st.playerBId, scoreA: st.scoreB, playerB: st.playerA, playerBId: st.playerAId, scoreB: st.scoreA, winner: st.winner === "A" ? "B" : st.winner === "B" ? "A" : null };
    });
  };

  const byRound = new Map<string, typeof series>();
  for (const s of series) {
    const arr = byRound.get(s.round) ?? [];
    arr.push(s);
    byRound.set(s.round, arr);
  }
  const rounds = [...byRound.entries()]
    .sort((a, b) => (ROUND_ORDER[a[0]] ?? 9) - (ROUND_ORDER[b[0]] ?? 9))
    .map(([round, ss]) => ({
      round,
      label: ROUND_LABEL[round] ?? round,
      series: ss
        .sort((a, b) => a.bracketIndex - b.bracketIndex)
        .map((s): BracketSeries => ({
          round,
          label: ROUND_LABEL[round] ?? round,
          aSeed: s.teamSeasonAId ? seedOf.get(s.teamSeasonAId) ?? null : null,
          aName: s.teamSeasonAId ? nameOf.get(s.teamSeasonAId) ?? "?" : "TBD",
          aTeamSeasonId: s.teamSeasonAId ?? null,
          bSeed: s.teamSeasonBId ? seedOf.get(s.teamSeasonBId) ?? null : null,
          bName: s.teamSeasonBId ? nameOf.get(s.teamSeasonBId) ?? "?" : "TBD",
          bTeamSeasonId: s.teamSeasonBId ?? null,
          scoreA: s.scoreA,
          scoreB: s.scoreB,
          winner: s.winnerTeamSeasonId === s.teamSeasonAId ? "A" : s.winnerTeamSeasonId === s.teamSeasonBId ? "B" : null,
          decided: !!s.winnerTeamSeasonId,
          sets: setsFor(s.teamSeasonAId, s.teamSeasonBId),
        })),
    }));

  const finalS = series.find((s) => s.round === "FINAL");
  const championTeamSeasonId = finalS?.winnerTeamSeasonId ?? null;
  const champion = championTeamSeasonId ? nameOf.get(championTeamSeasonId) ?? null : null;
  return { champion, championTeamSeasonId, rounds };
}

export interface RunRound {
  round: string;
  label: string;
  opponent: string | null;
  opponentTeamSeasonId: string | null;
  champScore: number;
  oppScore: number;
}

export interface ChampionRun {
  champion: string;
  championTeamSeasonId: string;
  rounds: RunRound[];
}

export async function getChampionRun(seasonName: string): Promise<ChampionRun | null> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) return null;
  const series = await prisma.playoffSeries.findMany({ where: { seasonId: season.id } });
  if (series.length === 0) return null;

  const ids = [...new Set(series.flatMap((s) => [s.teamSeasonAId, s.teamSeasonBId]).filter((x): x is string => !!x))];
  const teamSeasons = await prisma.teamSeason.findMany({ where: { id: { in: ids } }, include: { team: true } });
  const nameById = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const tsByTeam = new Map(teamSeasons.map((t) => [t.teamId, t.id]));

  // Determine the champion's teamSeason id.
  const [championship, entryCount] = await Promise.all([
    prisma.championship.findFirst({ where: { seasonId: season.id } }),
    prisma.playoffEntry.count({ where: { seasonId: season.id } }),
  ]);
  let championTsId: string | null = null;
  if (championship) {
    championTsId = tsByTeam.get(championship.teamId) ?? null;
  } else if (entryCount === 0) {
    // Historical champion-path import: A is the champion in the (first) row.
    championTsId = [...series].sort((a, b) => (ROUND_ORDER[a.round] ?? 9) - (ROUND_ORDER[b.round] ?? 9))[0]?.teamSeasonAId ?? null;
  } else {
    // Live bracket, not yet crowned → no champion to show.
    const final = series.find((s) => s.round === "FINAL");
    championTsId = final?.winnerTeamSeasonId ?? null;
    if (!championTsId) return null;
  }
  if (!championTsId) return null;

  // The champion's path = the series they appear in, in round order.
  const path = series
    .filter((s) => s.teamSeasonAId === championTsId || s.teamSeasonBId === championTsId)
    .sort((a, b) => (ROUND_ORDER[a.round] ?? 9) - (ROUND_ORDER[b.round] ?? 9));

  return {
    champion: nameById.get(championTsId) ?? "Champion",
    championTeamSeasonId: championTsId,
    rounds: path.map((s) => {
      const champIsA = s.teamSeasonAId === championTsId;
      const oppId = champIsA ? s.teamSeasonBId : s.teamSeasonAId;
      return {
        round: s.round,
        label: ROUND_LABEL[s.round] ?? s.round,
        opponent: oppId ? nameById.get(oppId) ?? "—" : null,
        opponentTeamSeasonId: oppId ?? null,
        champScore: (champIsA ? s.scoreA : s.scoreB) ?? 0,
        oppScore: (champIsA ? s.scoreB : s.scoreA) ?? 0,
      };
    }),
  };
}
