// Editing an imported/reconstructed season's schedule from the coverage grid: resolve the
// holes. A blank pair in the grid is either a game the TO still owes a result for, or a
// DESIGNED non-matchup (TT4 ran a near-round-robin where one pair per conference never
// played). This service handles both:
//   * recordHoleResult   -- create a Matchup with a team-level result (fills a real hole)
//   * markPairNotScheduled / unmarkPairNotScheduled -- flag/clear a designed bye
//
// Team-level results are stored directly on the Matchup (setsWonA/B, gamesWonA/B, winner) --
// the same shape the importer uses for team-only seasons, so no per-set data is needed.
// Operates on Matchup rows, so the season must be reconciled first (played games grouped
// into matchups); the grid gates the editor on that.
import { prisma } from "../db";

async function seasonId(seasonName: string): Promise<string> {
  const s = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!s) throw new Error(`No season "${seasonName}"`);
  return s.id;
}

// Both teams must belong to the season. Returns them in canonical (lo, hi) id order.
async function validatePair(sid: string, aId: string, bId: string): Promise<[string, string]> {
  if (aId === bId) throw new Error("A team can't play itself.");
  const teams = await prisma.teamSeason.count({ where: { id: { in: [aId, bId] }, seasonId: sid } });
  if (teams !== 2) throw new Error("Both teams must belong to this season.");
  return aId < bId ? [aId, bId] : [bId, aId];
}

// Has this pair actually met? (a matchup between them, in any week of the season.)
async function existingMatchup(sid: string, aId: string, bId: string) {
  return prisma.matchup.findFirst({
    where: {
      week: { seasonId: sid },
      OR: [
        { teamSeasonAId: aId, teamSeasonBId: bId },
        { teamSeasonAId: bId, teamSeasonBId: aId },
      ],
    },
    select: { id: true },
  });
}

export interface HoleResultInput {
  setsA: number;
  setsB: number;
  gamesA?: number;
  gamesB?: number;
  weekNumber: number;
  // Double DQ: the match was scheduled but NOBODY played and it doesn't matter.
  // Records a decided 0-0 with no winner (a DRAW in standings) so the pair stops
  // being a hole -- distinct from a bye, where they were never scheduled at all.
  dq?: boolean;
}

// Fill a hole: create a Matchup (in the given week) between the two teams with a team-level
// result. Rejects if they already have a matchup (that's an edit -> use the matchup console).
export async function recordHoleResult(seasonName: string, aId: string, bId: string, input: HoleResultInput) {
  const sid = await seasonId(seasonName);
  await validatePair(sid, aId, bId);

  const setsA = input.dq ? 0 : Math.trunc(input.setsA), setsB = input.dq ? 0 : Math.trunc(input.setsB);
  const gamesA = input.dq ? 0 : Math.max(0, Math.trunc(input.gamesA ?? 0)), gamesB = input.dq ? 0 : Math.max(0, Math.trunc(input.gamesB ?? 0));
  if (setsA < 0 || setsB < 0) throw new Error("Set counts can't be negative.");
  if (!input.dq && setsA === 0 && setsB === 0) throw new Error("Enter the set score, or use DQ if nobody played.");
  const num = Math.trunc(input.weekNumber);
  if (!Number.isFinite(num) || num < 1) throw new Error("Pick a week for this game.");

  if (await existingMatchup(sid, aId, bId)) {
    throw new Error("These teams already have a matchup — edit its result in the matchup console instead.");
  }

  const week = await prisma.week.upsert({
    where: { seasonId_number: { seasonId: sid, number: num } },
    create: { seasonId: sid, number: num, kind: "ROUND_ROBIN" },
    update: {},
  });

  // Store A/B as given; winner by set majority (null on an exact tie).
  const winnerTeamSeasonId = setsA > setsB ? aId : setsB > setsA ? bId : null;
  await prisma.matchup.create({
    data: {
      weekId: week.id,
      teamSeasonAId: aId,
      teamSeasonBId: bId,
      setsWonA: setsA,
      setsWonB: setsB,
      gamesWonA: gamesA,
      gamesWonB: gamesB,
      winnerTeamSeasonId,
    },
  });

  // Recording a result supersedes any "not scheduled" mark for the pair.
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  await prisma.scheduleExclusion.deleteMany({ where: { seasonId: sid, teamSeasonAId: lo, teamSeasonBId: hi } });

  return { weekNumber: num };
}

// Mark a pair as a designed non-matchup (bye): the grid stops treating their blank as a hole.
export async function markPairNotScheduled(seasonName: string, aId: string, bId: string) {
  const sid = await seasonId(seasonName);
  const [lo, hi] = await validatePair(sid, aId, bId);
  if (await existingMatchup(sid, aId, bId)) {
    throw new Error("These teams have a recorded game — they can't be marked as never playing.");
  }
  await prisma.scheduleExclusion.upsert({
    where: { seasonId_teamSeasonAId_teamSeasonBId: { seasonId: sid, teamSeasonAId: lo, teamSeasonBId: hi } },
    create: { seasonId: sid, teamSeasonAId: lo, teamSeasonBId: hi },
    update: {},
  });
}

// Clear a designed-bye mark: the pair goes back to being a fillable hole.
export async function unmarkPairNotScheduled(seasonName: string, aId: string, bId: string) {
  const sid = await seasonId(seasonName);
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  await prisma.scheduleExclusion.deleteMany({ where: { seasonId: sid, teamSeasonAId: lo, teamSeasonBId: hi } });
}
