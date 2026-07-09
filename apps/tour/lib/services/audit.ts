// Season completeness audit -- "what still needs settling?". Derive-on-read over
// Week/Matchup/TourSet rows (truth): per-week decided counts, every pending matchup
// with WHY it's pending, and a per-team "who's behind" tally. Read-only.
//
// A matchup is SETTLED when its rollup persisted a team result (setsWonA != null --
// see report.ts rollupMatchup: a team clinched the majority or all sets confirmed).
// A pending matchup is categorized by its most actionable blocker:
//   DISPUTED         a set needs a TO ruling (admin report path)
//   AWAITING_CONFIRM a result is in, waiting on the opponent's confirm
//   UNPAIRED         captains started but haven't finished the lineup
//   UNPLAYED         fully paired, sets just haven't been played/reported yet
//   NOT_STARTED      zero sets -- pairing hasn't begun (normal for future weeks)
import { prisma } from "../db";
import { subOnlyKeySet } from "./roster-ops";

export type PendingCategory = "DISPUTED" | "AWAITING_CONFIRM" | "UNPAIRED" | "UNPLAYED" | "NOT_STARTED";

export interface PendingSet {
  setId: string;
  aSeed: number;
  bSeed: number;
  aName: string;
  bName: string;
  aPlayerId: string;
  bPlayerId: string;
  aIsSub: boolean; // sub-only membership -- render "sub", not the stored seed snapshot
  bIsSub: boolean;
  status: string;
  reported: boolean; // has a recorded result (CONFIRMED/FORFEIT/REPORTED)
  teamAGames: number | null; // games won by team A in this set (the game% tiebreaker input); null if unreported
  teamBGames: number | null;
}

export interface PendingMatchup {
  matchupId: string;
  week: number;
  aName: string;
  bName: string;
  aTeamSeasonId: string;
  bTeamSeasonId: string;
  category: PendingCategory;
  paired: number; // sets created (any status)
  expected: number; // season.teamSize
  confirmed: number; // CONFIRMED + FORFEIT
  awaitingConfirm: number; // REPORTED
  disputed: number; // DISPUTED
  unplayed: number; // PROPOSED + SCHEDULED
  sets: PendingSet[]; // for inline reporting on the audit page
}

export async function getSeasonAudit(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    select: { id: true, name: true, state: true, teamSize: true, setsToWin: true },
  });
  if (!season) return null;

  // Loose imported sets (REGULAR, week-tagged) that could be rebuilt into matchups --
  // nonzero here with zero weeks means "imported season, not yet reconstructed".
  const importedSetCount = await prisma.tourSet.count({
    where: { seasonId: season.id, bracket: "REGULAR", week: { not: null } },
  });

  const [weeks, teamSeasons, series] = await Promise.all([
    prisma.week.findMany({
      // Regular-season weeks only -- playoff series are audited via the dedicated `series` path,
      // so playoff matchups must not double-count in the matchup totals / pending / per-team tally.
      where: { seasonId: season.id, kind: { not: "PLAYOFF" } },
      include: {
        matchups: {
          include: { sets: { select: { id: true, status: true, playerAId: true, playerBId: true, seedA: true, seedB: true, matchId: true }, orderBy: { seedA: "asc" } } },
        },
      },
      orderBy: { number: "asc" },
    }),
    prisma.teamSeason.findMany({
      where: { seasonId: season.id },
      include: { team: { select: { name: true } } },
    }),
    prisma.playoffSeries.findMany({
      where: { seasonId: season.id },
      orderBy: [{ round: "asc" }, { bracketIndex: "asc" }],
    }),
  ]);
  const teamName = new Map(teamSeasons.map((t) => [t.id, t.team.name]));

  const pending: PendingMatchup[] = [];
  const rawSets = new Map<string, { id: string; status: string; playerAId: string; playerBId: string; seedA: number; seedB: number; matchId: string | null }[]>();
  const weekRows = weeks.map((w) => {
    let decided = 0;
    for (const m of w.matchups) {
      if (m.setsWonA != null && m.setsWonB != null) {
        decided++;
        continue;
      }
      let confirmed = 0, awaiting = 0, disputed = 0, unplayed = 0;
      for (const s of m.sets) {
        if (s.status === "CONFIRMED" || s.status === "FORFEIT") confirmed++;
        else if (s.status === "REPORTED") awaiting++;
        else if (s.status === "DISPUTED") disputed++;
        else unplayed++; // PROPOSED | SCHEDULED
      }
      const paired = m.sets.length;
      const category: PendingCategory =
        disputed > 0 ? "DISPUTED"
        : awaiting > 0 ? "AWAITING_CONFIRM"
        : paired === 0 ? "NOT_STARTED"
        : paired < season.teamSize ? "UNPAIRED"
        : "UNPLAYED";
      rawSets.set(m.id, m.sets);
      pending.push({
        matchupId: m.id,
        week: w.number,
        aName: teamName.get(m.teamSeasonAId) ?? "?",
        bName: teamName.get(m.teamSeasonBId) ?? "?",
        aTeamSeasonId: m.teamSeasonAId,
        bTeamSeasonId: m.teamSeasonBId,
        category,
        paired,
        expected: season.teamSize,
        confirmed,
        awaitingConfirm: awaiting,
        disputed,
        unplayed,
        sets: [], // enriched with player names below
      });
    }
    return { weekId: w.id, number: w.number, kind: w.kind, total: w.matchups.length, decided };
  });

  // Resolve player names for pending sets (one query) so the page can render
  // inline report controls without a per-matchup round trip.
  const playerIds = new Set<string>();
  for (const sets of rawSets.values()) for (const s of sets) { playerIds.add(s.playerAId); playerIds.add(s.playerBId); }
  const [players, subOnly] = await Promise.all([
    playerIds.size
      ? prisma.player.findMany({ where: { id: { in: [...playerIds] } }, select: { id: true, displayName: true } })
      : Promise.resolve([]),
    subOnlyKeySet(teamSeasons.map((t) => t.id)),
  ]);
  const playerName = new Map(players.map((p) => [p.id, p.displayName]));

  // Pull the game scores for reported sets so the inline controls prefill the current
  // games (they feed the game% tiebreaker, so a TO wants to see/fix them, not just W/L).
  const matchIds: string[] = [];
  for (const sets of rawSets.values()) for (const s of sets) if (s.matchId) matchIds.push(s.matchId);
  const matches = matchIds.length
    ? await prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, playerAId: true, gamesWonA: true, gamesWonB: true } })
    : [];
  const matchById = new Map(matches.map((m) => [m.id, m]));

  for (const p of pending) {
    p.sets = (rawSets.get(p.matchupId) ?? []).map((s) => {
      const m = s.matchId ? matchById.get(s.matchId) : undefined;
      // Align the match's games to the set's team A by player id (same contract as rollup).
      const teamAGames = m ? (m.playerAId === s.playerAId ? m.gamesWonA : m.gamesWonB) : null;
      const teamBGames = m ? (m.playerAId === s.playerAId ? m.gamesWonB : m.gamesWonA) : null;
      return {
        setId: s.id,
        aSeed: s.seedA,
        bSeed: s.seedB,
        aName: playerName.get(s.playerAId) ?? "?",
        bName: playerName.get(s.playerBId) ?? "?",
        aPlayerId: s.playerAId,
        bPlayerId: s.playerBId,
        aIsSub: subOnly.has(`${p.aTeamSeasonId}|${s.playerAId}`),
        bIsSub: subOnly.has(`${p.bTeamSeasonId}|${s.playerBId}`),
        status: s.status,
        reported: s.status === "CONFIRMED" || s.status === "FORFEIT" || s.status === "REPORTED",
        teamAGames,
        teamBGames,
      };
    });
  }

  // Per-team pending tally -- "which teams still owe games", worst first.
  const byTeam = new Map<string, { name: string; count: number; weeks: number[] }>();
  for (const w of weeks) {
    for (const m of w.matchups) {
      if (m.setsWonA != null && m.setsWonB != null) continue;
      for (const tsId of [m.teamSeasonAId, m.teamSeasonBId]) {
        const cur = byTeam.get(tsId) ?? { name: teamName.get(tsId) ?? "?", count: 0, weeks: [] };
        cur.count++;
        if (!cur.weeks.includes(w.number)) cur.weeks.push(w.number);
        byTeam.set(tsId, cur);
      }
    }
  }
  const teams = [...byTeam.entries()]
    .map(([teamSeasonId, t]) => ({ teamSeasonId, ...t, weeks: t.weeks.sort((a, b) => a - b) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Playoffs (when a bracket exists): series with both teams set but no winner.
  const pendingSeries = series
    .filter((s) => s.teamSeasonAId && s.teamSeasonBId && !s.winnerTeamSeasonId)
    .map((s) => ({
      seriesId: s.id,
      round: s.round,
      aName: teamName.get(s.teamSeasonAId!) ?? "?",
      bName: teamName.get(s.teamSeasonBId!) ?? "?",
      scoreA: s.scoreA,
      scoreB: s.scoreB,
    }));

  const totalMatchups = weekRows.reduce((n, w) => n + w.total, 0);
  const decidedMatchups = weekRows.reduce((n, w) => n + w.decided, 0);

  // Most-urgent first: TO rulings, then one-click confirms, then lineups, then play,
  // then the not-yet-started tail (future weeks -- informational, not actionable).
  const order: PendingCategory[] = ["DISPUTED", "AWAITING_CONFIRM", "UNPAIRED", "UNPLAYED", "NOT_STARTED"];
  pending.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.week - b.week);

  return {
    season,
    totals: { matchups: totalMatchups, decided: decidedMatchups, pending: totalMatchups - decidedMatchups },
    weeks: weekRows,
    pending,
    teams,
    hasSeries: series.length > 0,
    pendingSeries,
    importedSetCount, // >0 with matchups==0 => imported season awaiting reconstruction
  };
}
