// Reconstruct Week + Matchup rows for an IMPORTED season from its flat TourSets.
// Imported seasons store every played game as a loose TourSet (seasonId + week Int +
// teamSeasonAId/BId + playerAId/BId), with matchupId null and no Week/Matchup rows --
// the importer computes the schedule then discards it. This rebuilds it from the data
// already in the DB, so the matchup-based tooling (audit, overlays, matchup reads,
// standings) works on imported seasons too.
//
// Correctness hinge: rollupMatchup credits a set's win to the MATCHUP's team A only when
// the set's playerA is on team A (it aligns by player id). So when we pick a canonical
// team A/B for each (week, team-pair) group, any set stored in the opposite orientation
// is swapped (teamSeason/player/seed A<->B) so its playerA lands on the matchup's team A.
// The linked Match row is left untouched -- rollup re-aligns games/winner by player id.
//
// REGULAR bracket only; playoff sets (bracket PLAYOFF, week null) stay in PlayoffSeries.
// preview (read-only) and build (writes) share planMatchups so what you see is what you get.
import { prisma } from "../db";
import { rollupMatchup } from "./report";

interface SetRow {
  id: string;
  week: number;
  teamSeasonAId: string;
  teamSeasonBId: string;
  playerAId: string;
  playerBId: string;
  seedA: number;
  seedB: number;
  matchId: string | null;
  status: string;
}

interface PlannedMatchup {
  week: number;
  teamA: string; // canonical (lexicographically smaller id)
  teamB: string;
  rows: SetRow[];
}

async function loadReconcilableSets(seasonId: string): Promise<SetRow[]> {
  const sets = await prisma.tourSet.findMany({
    where: { seasonId, week: { not: null }, bracket: "REGULAR", teamSeasonAId: { not: null }, teamSeasonBId: { not: null } },
    select: { id: true, week: true, teamSeasonAId: true, teamSeasonBId: true, playerAId: true, playerBId: true, seedA: true, seedB: true, matchId: true, status: true },
  });
  return sets.map((s) => ({
    id: s.id, week: s.week!, teamSeasonAId: s.teamSeasonAId!, teamSeasonBId: s.teamSeasonBId!,
    playerAId: s.playerAId, playerBId: s.playerBId, seedA: s.seedA, seedB: s.seedB, matchId: s.matchId, status: s.status,
  }));
}

// Group sets into matchups by (week, unordered team pair); canonical team A = smaller id.
function planMatchups(sets: SetRow[]): PlannedMatchup[] {
  const groups = new Map<string, PlannedMatchup>();
  for (const s of sets) {
    const [teamA, teamB] = s.teamSeasonAId < s.teamSeasonBId ? [s.teamSeasonAId, s.teamSeasonBId] : [s.teamSeasonBId, s.teamSeasonAId];
    const key = `${s.week}|${teamA}|${teamB}`;
    const g = groups.get(key) ?? { week: s.week, teamA, teamB, rows: [] };
    g.rows.push(s);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export interface ReconcilePreviewRow {
  week: number;
  teamAName: string;
  teamBName: string;
  setsWonA: number;
  setsWonB: number;
  gamesWonA: number; // total games won across the matchup's sets (the game% tiebreaker input)
  gamesWonB: number;
  setCount: number;
  decided: boolean;
  winnerName: string | null;
}

// Read-only: compute exactly what build would produce (matchups + their rolled-up scores)
// without writing anything, so a TO can eyeball it before committing.
export async function previewMatchupsFromSets(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, setsToWin: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  const sets = await loadReconcilableSets(season.id);
  if (sets.length === 0) return { totals: { weeks: 0, matchups: 0, sets: 0, flipped: 0, decided: 0 }, matchups: [] as ReconcilePreviewRow[] };

  const planned = planMatchups(sets);
  const teamIds = [...new Set(sets.flatMap((s) => [s.teamSeasonAId, s.teamSeasonBId]))];
  const teams = await prisma.teamSeason.findMany({ where: { id: { in: teamIds } }, select: { id: true, team: { select: { name: true } } } });
  const name = new Map(teams.map((t) => [t.id, t.team.name]));
  const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
  const matches = await prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, winnerId: true, playerAId: true, gamesWonA: true, gamesWonB: true } });
  const mById = new Map(matches.map((m) => [m.id, m]));

  let flipped = 0;
  const matchups: ReconcilePreviewRow[] = planned.map((g) => {
    let setsA = 0, setsB = 0, gamesA = 0, gamesB = 0, confirmed = 0;
    for (const s of g.rows) {
      const flip = s.teamSeasonAId !== g.teamA;
      if (flip) flipped++;
      const pA = flip ? s.playerBId : s.playerAId; // oriented player on the matchup's team A
      const pB = flip ? s.playerAId : s.playerBId;
      if ((s.status === "CONFIRMED" || s.status === "FORFEIT") && s.matchId) {
        const m = mById.get(s.matchId);
        if (m) {
          confirmed++;
          if (m.winnerId === pA) setsA++; else if (m.winnerId === pB) setsB++;
          // Align games to team A by the same player-id contract rollupMatchup uses.
          gamesA += m.playerAId === pA ? m.gamesWonA : m.gamesWonB;
          gamesB += m.playerAId === pA ? m.gamesWonB : m.gamesWonA;
        }
      }
    }
    const total = g.rows.length;
    const decided = setsA >= season.setsToWin || setsB >= season.setsToWin || (total > 0 && confirmed === total);
    const winner = !decided ? null : setsA > setsB ? g.teamA : setsB > setsA ? g.teamB : null;
    return {
      week: g.week, teamAName: name.get(g.teamA) ?? "?", teamBName: name.get(g.teamB) ?? "?",
      setsWonA: setsA, setsWonB: setsB, gamesWonA: gamesA, gamesWonB: gamesB, setCount: total,
      decided, winnerName: winner ? name.get(winner) ?? null : null,
    };
  }).sort((a, b) => a.week - b.week || a.teamAName.localeCompare(b.teamAName));

  const weeks = new Set(planned.map((g) => g.week)).size;
  return {
    totals: { weeks, matchups: planned.length, sets: sets.length, flipped, decided: matchups.filter((m) => m.decided).length },
    matchups,
  };
}

export async function buildMatchupsFromSets(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);

  // Detach any prior set->matchup links BEFORE dropping matchups (Matchup->TourSet is
  // onDelete: Cascade; deleting an attached matchup would delete the imported sets).
  await prisma.tourSet.updateMany({ where: { seasonId: season.id, matchupId: { not: null } }, data: { matchupId: null } });
  await prisma.week.deleteMany({ where: { seasonId: season.id } });

  const sets = await loadReconcilableSets(season.id);
  if (sets.length === 0) return { weeks: 0, matchups: 0, sets: 0, flipped: 0 };
  const planned = planMatchups(sets);

  const weekNums = [...new Set(planned.map((g) => g.week))].sort((a, b) => a - b);
  const weekIdByNum = new Map<number, string>();
  for (const num of weekNums) {
    const wk = await prisma.week.create({ data: { seasonId: season.id, number: num, kind: "ROUND_ROBIN" } });
    weekIdByNum.set(num, wk.id);
  }

  const matchupIds: string[] = [];
  let flipped = 0;
  for (const g of planned) {
    const mu = await prisma.matchup.create({ data: { weekId: weekIdByNum.get(g.week)!, teamSeasonAId: g.teamA, teamSeasonBId: g.teamB } });
    matchupIds.push(mu.id);

    const straight = g.rows.filter((s) => s.teamSeasonAId === g.teamA).map((s) => s.id);
    if (straight.length) await prisma.tourSet.updateMany({ where: { id: { in: straight } }, data: { matchupId: mu.id } });

    // Opposite-orientation sets: swap A<->B so playerA is on the matchup's team A.
    for (const s of g.rows.filter((r) => r.teamSeasonAId !== g.teamA)) {
      flipped++;
      await prisma.tourSet.update({
        where: { id: s.id },
        data: {
          matchupId: mu.id,
          teamSeasonAId: s.teamSeasonBId, teamSeasonBId: s.teamSeasonAId,
          playerAId: s.playerBId, playerBId: s.playerAId,
          seedA: s.seedB, seedB: s.seedA,
        },
      });
    }
  }

  for (const id of matchupIds) await rollupMatchup(id);

  return { weeks: weekNums.length, matchups: matchupIds.length, sets: sets.length, flipped };
}
