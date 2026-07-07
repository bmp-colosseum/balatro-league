// Soft weekly deadlines. Each Week can carry a target date (Week.deadlineAt); it's a
// nudge the TO sets, never enforced (no auto-forfeit) -- "rails not gates". Blank = no
// target shown. Authored + shown in ET; stored as a UTC instant. The field existed in
// the schema (documented "Sun 23:59 ET") but nothing wrote or read it until now.
import { prisma } from "../db";
import { etWallToUtc, addDaysWall } from "../date";

async function seasonIdOf(seasonName: string): Promise<string> {
  const s = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!s) throw new Error(`No season "${seasonName}"`);
  return s.id;
}

// weekNumber -> target date (null when unset). The reader every display surface uses.
export async function weekDeadlines(seasonId: string): Promise<Map<number, Date | null>> {
  const weeks = await prisma.week.findMany({ where: { seasonId }, select: { number: true, deadlineAt: true } });
  return new Map(weeks.map((w) => [w.number, w.deadlineAt]));
}

export async function weekDeadlinesByName(seasonName: string): Promise<Map<number, Date | null>> {
  const s = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  return s ? weekDeadlines(s.id) : new Map();
}

// Set (or clear, with wall=null) one week's target. wall is an ET datetime-local string.
export async function setWeekDeadline(seasonName: string, weekNumber: number, wall: string | null) {
  const seasonId = await seasonIdOf(seasonName);
  const deadlineAt = wall ? etWallToUtc(wall) : null;
  if (wall && !deadlineAt) throw new Error("Couldn't read that date.");
  const r = await prisma.week.updateMany({ where: { seasonId, number: weekNumber }, data: { deadlineAt } });
  if (r.count === 0) throw new Error(`No week ${weekNumber} in this season.`);
  return { ok: true, cleared: !wall };
}

// Fill every week from a first-week target on a fixed cadence (default weekly). Keeps
// the same ET time-of-day each week (DST-safe), so "Sun 23:59 ET" stays 23:59 all season.
export async function applyWeeklyCadence(seasonName: string, firstWall: string, intervalDays = 7) {
  const seasonId = await seasonIdOf(seasonName);
  if (!firstWall) throw new Error("Pick the first week's target.");
  if (!etWallToUtc(firstWall)) throw new Error("Couldn't read that date.");
  const weeks = await prisma.week.findMany({ where: { seasonId }, select: { id: true }, orderBy: { number: "asc" } });
  if (!weeks.length) throw new Error("Generate the schedule first -- there are no weeks yet.");
  for (let i = 0; i < weeks.length; i++) {
    await prisma.week.update({ where: { id: weeks[i].id }, data: { deadlineAt: etWallToUtc(addDaysWall(firstWall, intervalDays * i)) } });
  }
  return { count: weeks.length };
}

// Clear every week's target (back to no deadlines shown).
export async function clearAllDeadlines(seasonName: string) {
  const seasonId = await seasonIdOf(seasonName);
  const r = await prisma.week.updateMany({ where: { seasonId }, data: { deadlineAt: null } });
  return { count: r.count };
}
