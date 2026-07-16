// The champion's playoff run for a season (Hall of Fame). Handles two shapes:
//   • Historical imports — only the winner's path is recorded (QF→SF→Final), with
//     the champion stored as teamSeasonA in every row (no PlayoffEntry).
//   • Live B8 brackets — a full single-elim bracket (PlayoffEntry seeds + every
//     series). The champion is the crowned team (Championship) or the FINAL winner;
//     the run is the series the champion actually played.
import { prisma } from "./db";
import { seedAtWeekResolver } from "./services/roster-ops";

const ROUND_ORDER: Record<string, number> = { ROUND_OF_64: 0, ROUND_OF_32: 1, ROUND_OF_16: 2, QUARTERFINAL: 3, SEMIFINAL: 4, FINAL: 5 };
const ROUND_LABEL: Record<string, string> = {
  ROUND_OF_64: "Round of 64",
  ROUND_OF_32: "Round of 32",
  ROUND_OF_16: "Round of 16",
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
  seedA: number | null;
  scoreA: number;
  playerB: string;
  playerBId: string;
  seedB: number | null;
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
  const poSets = await prisma.tourSet.findMany({ where: { seasonId: season.id, bracket: "PLAYOFF" }, select: { playerAId: true, playerBId: true, matchId: true, teamSeasonAId: true, teamSeasonBId: true } });
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
  // Each player's seed going into the playoffs (a high week picks up any playoff-block re-seed).
  const seedAt = await seedAtWeekResolver([...new Set([...teamOfPlayer.values()])]);
  const PLAYOFF_WK = 999;
  const seedOfPlayer = (pid: string) => { const t = teamOfPlayer.get(pid); return t ? seedAt(t, PLAYOFF_WK, pid) : null; };
  const pairKey = (x: string, y: string) => [x, y].sort().join("|");
  const setsByPair = new Map<string, BracketSet[]>();
  for (const s of poSets) {
    // Prefer the set's stamped team (live playoff sets) so a cross-team sub is attributed
    // to the team they played FOR; fall back to roster membership for historical imports.
    const tA = s.teamSeasonAId ?? teamOfPlayer.get(s.playerAId), tB = s.teamSeasonBId ?? teamOfPlayer.get(s.playerBId);
    const m = s.matchId ? poMatchById.get(s.matchId) : undefined;
    if (!tA || !tB || !m) continue;
    (setsByPair.get(pairKey(tA, tB)) ?? setsByPair.set(pairKey(tA, tB), []).get(pairKey(tA, tB))!).push({
      playerA: poName.get(s.playerAId) ?? "?", playerAId: s.playerAId, seedA: seedOfPlayer(s.playerAId),
      playerB: poName.get(s.playerBId) ?? "?", playerBId: s.playerBId, seedB: seedOfPlayer(s.playerBId),
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
      return aIsTeamA ? st : { playerA: st.playerB, playerAId: st.playerBId, seedA: st.seedB, scoreA: st.scoreB, playerB: st.playerA, playerBId: st.playerAId, seedB: st.seedA, scoreB: st.scoreA, winner: st.winner === "A" ? "B" : st.winner === "B" ? "A" : null };
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
        .map((s): BracketSeries => {
          const sets = setsFor(s.teamSeasonAId, s.teamSeasonBId);
          // A live series only persists scoreA/scoreB once decided; until then derive the
          // running set-win tally from its confirmed sets so the score shows in progress.
          const liveA = sets.filter((x) => x.winner === "A").length;
          const liveB = sets.filter((x) => x.winner === "B").length;
          const scoreA = s.scoreA ?? (sets.length ? liveA : null);
          const scoreB = s.scoreB ?? (sets.length ? liveB : null);
          return {
            round,
            label: ROUND_LABEL[round] ?? round,
            aSeed: s.teamSeasonAId ? seedOf.get(s.teamSeasonAId) ?? null : null,
            aName: s.teamSeasonAId ? nameOf.get(s.teamSeasonAId) ?? "?" : "TBD",
            aTeamSeasonId: s.teamSeasonAId ?? null,
            bSeed: s.teamSeasonBId ? seedOf.get(s.teamSeasonBId) ?? null : null,
            bName: s.teamSeasonBId ? nameOf.get(s.teamSeasonBId) ?? "?" : "TBD",
            bTeamSeasonId: s.teamSeasonBId ?? null,
            scoreA,
            scoreB,
            winner: s.winnerTeamSeasonId === s.teamSeasonAId ? "A" : s.winnerTeamSeasonId === s.teamSeasonBId ? "B" : null,
            decided: !!s.winnerTeamSeasonId,
            sets,
          };
        }),
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

  // Determine the champion's teamSeason id: a stored Championship, else the FINAL's winner
  // (full bracket — old champion-path imports also set the FINAL winner), else the team that
  // won a series and never lost one.
  const championship = await prisma.championship.findFirst({ where: { seasonId: season.id } });
  let championTsId: string | null = championship ? tsByTeam.get(championship.teamId) ?? null : null;
  if (!championTsId) championTsId = series.find((s) => s.round === "FINAL")?.winnerTeamSeasonId ?? null;
  // "Won a series and never lost one" only names a champion once the bracket is fully
  // resolved -- otherwise a team that has merely won its early rounds (and not yet played
  // the final) would be crowned mid-playoffs. In progress => no champion yet.
  if (!championTsId && series.every((s) => s.winnerTeamSeasonId != null)) {
    const winners = new Set<string>(), losers = new Set<string>();
    for (const s of series) {
      if (!s.winnerTeamSeasonId) continue;
      winners.add(s.winnerTeamSeasonId);
      const loser = s.winnerTeamSeasonId === s.teamSeasonAId ? s.teamSeasonBId : s.teamSeasonAId;
      if (loser) losers.add(loser);
    }
    championTsId = [...winners].find((w) => !losers.has(w)) ?? null;
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
