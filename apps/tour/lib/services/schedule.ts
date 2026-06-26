// Schedule service. Lays each conference's round-robin into week slots via
// tour-core `generateSchedule` (which wraps competition-core `roundRobinPairs`),
// then persists Week + Matchup rows. v1 is a pure in-conference round-robin — the
// special weeks (Rival / Cross-Conf / Seeded) are a later TO refinement (§6.4).
//
// Teams come from the draft (TeamSeason rows carry conference + seed), so this runs
// once the draft has built the teams. Nothing here is irreversible (resetSchedule).
import { prisma } from "../db";
import { generateSchedule } from "@balatro/tour-core";
import { roundRobinPairs } from "@balatro/competition-core";

// Conferences with their teams (seed order) — the raw material for a schedule.
async function loadConferences(seasonId: string) {
  const conferences = await prisma.conference.findMany({
    where: { seasonId },
    include: { teamSeasons: { include: { team: true }, orderBy: { seed: "asc" } } },
    orderBy: { name: "asc" },
  });
  return conferences.map((c) => ({
    id: c.id,
    name: c.name,
    teams: c.teamSeasons.map((t) => ({ id: t.id, name: t.team.name, seed: t.seed })),
  }));
}

// The plan view: conferences + their team counts + the week count a round-robin
// needs (the largest conference's round count), and whether a schedule exists.
export async function getScheduleSetup(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    include: { _count: { select: { weeks: true } } },
  });
  if (!season) return null;
  const conferences = await loadConferences(season.id);
  const totalTeams = conferences.reduce((n, c) => n + c.teams.length, 0);
  const weekCount = Math.max(0, ...conferences.map((c) => roundRobinPairs(c.teams.map((t) => t.id)).length));
  return { season, conferences, totalTeams, weekCount, hasSchedule: season._count.weeks > 0 };
}

// Generate + persist the regular season. Each conference plays its own round-robin
// in lockstep weeks (smaller conferences get byes in the trailing weeks). Idempotent
// guard: refuses to overwrite an existing schedule (reset first).
export async function generateSeasonSchedule(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    include: { _count: { select: { weeks: true } } },
  });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if (season._count.weeks > 0) throw new Error("A schedule already exists for this season — reset it first.");

  const conferences = await loadConferences(season.id);
  const withTeams = conferences.filter((c) => c.teams.length >= 2);
  if (withTeams.length === 0) throw new Error("No conference has 2+ teams yet — set up the draft first.");

  const totalWeeks = Math.max(...withTeams.map((c) => roundRobinPairs(c.teams.map((t) => t.id)).length));
  const fixtures = generateSchedule({
    conferences: withTeams.map((c) => ({ id: c.id, teamSeasonIds: c.teams.map((t) => t.id) })),
    totalWeeks,
  });

  // Group fixtures by week number — each week is one Week row with N Matchups.
  const byWeek = new Map<number, typeof fixtures>();
  for (const f of fixtures) {
    const arr = byWeek.get(f.round) ?? [];
    arr.push(f);
    byWeek.set(f.round, arr);
  }

  let matchups = 0;
  for (const [number, fxs] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    await prisma.week.create({
      data: {
        seasonId: season.id,
        number,
        kind: "ROUND_ROBIN",
        matchups: {
          create: fxs.map((f) => ({ teamSeasonAId: f.homeId, teamSeasonBId: f.awayId })),
        },
      },
    });
    matchups += fxs.length;
  }

  return { weeks: byWeek.size, matchups };
}

// The generated board: weeks in order, each with its team-vs-team matchups + the
// conference + any recorded team result.
export async function getSchedule(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName } });
  if (!season) return null;

  const [weeks, teamSeasons] = await Promise.all([
    prisma.week.findMany({
      where: { seasonId: season.id },
      include: { matchups: true },
      orderBy: { number: "asc" },
    }),
    prisma.teamSeason.findMany({
      where: { seasonId: season.id },
      include: { team: true, conference: true },
    }),
  ]);
  const info = new Map(teamSeasons.map((t) => [t.id, { name: t.team.name, conference: t.conference.name }]));

  return {
    season,
    weeks: weeks.map((w) => ({
      id: w.id,
      number: w.number,
      kind: w.kind,
      matchups: w.matchups.map((m) => ({
        id: m.id,
        aName: info.get(m.teamSeasonAId)?.name ?? "?",
        bName: info.get(m.teamSeasonBId)?.name ?? "?",
        conference: info.get(m.teamSeasonAId)?.conference ?? "",
        setsWonA: m.setsWonA,
        setsWonB: m.setsWonB,
        winnerTeamSeasonId: m.winnerTeamSeasonId,
      })),
    })),
  };
}

// Wipe the schedule so it can be regenerated. Cascades Week → Matchup → TourSet;
// the per-set core Matches aren't cascaded (referenced by plain id), so drop them
// too. Pre-launch, destructive resets are fine ([[feedback_no_backcompat]]).
export async function resetSchedule(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  const sets = await prisma.tourSet.findMany({
    where: { matchup: { week: { seasonId: season.id } } },
    select: { matchId: true },
  });
  await prisma.week.deleteMany({ where: { seasonId: season.id } });
  const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
  if (matchIds.length) await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
}
