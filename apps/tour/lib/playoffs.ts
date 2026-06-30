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
}

export interface PublicBracket {
  champion: string | null;
  championTeamSeasonId: string | null;
  rounds: { round: string; label: string; series: BracketSeries[] }[];
}

// The full single-elim bracket for a season — only for live B8 seasons (which have
// PlayoffEntry seeds + the complete set of series). Historical champion-path imports
// (no entries) return null; the page falls back to the champion run / projection.
export async function getPublicBracket(seasonName: string): Promise<PublicBracket | null> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) return null;
  const entries = await prisma.playoffEntry.findMany({ where: { seasonId: season.id } });
  if (entries.length === 0) return null;

  const series = await prisma.playoffSeries.findMany({ where: { seasonId: season.id }, orderBy: { bracketIndex: "asc" } });
  const tsIds = [...new Set([...entries.map((e) => e.teamSeasonId), ...series.flatMap((s) => [s.teamSeasonAId, s.teamSeasonBId])].filter((x): x is string => !!x))];
  const teamSeasons = await prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: true } });
  const nameOf = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const seedOf = new Map(entries.map((e) => [e.teamSeasonId, e.seed]));

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
