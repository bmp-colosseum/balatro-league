import "server-only";

// Lock in each division's schedule at activation: generate the assigned-opponent
// graph (4 opponents per player; Legendary + Rare 1 play a full round-robin) and
// persist it as PENDING 0–0 Match rows. After this, "your schedule" is real data
// — and because reporting find-or-creates a match by (division, players, format),
// a report just UPDATES the pre-created row, so nothing about /start-match or
// reporting breaks. Idempotent: existing matches (incl. already-played ones) are
// never touched.

import { prisma } from "@/lib/prisma";
import { generateSchedule } from "@/lib/schedule";
import { getPlacementRules } from "@/lib/placement-rules";

export async function lockDivisionSchedules(seasonId: string): Promise<{ created: number; divisions: number }> {
  const rules = await getPlacementRules();
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: {
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: {
          members: {
            where: { status: "ACTIVE" },
            select: { player: { select: { id: true, hiddenMmr: true } } },
          },
        },
      },
    },
  });
  if (!season) return { created: 0, divisions: 0 };

  let created = 0;
  let divisionsWithSchedule = 0;

  for (let idx = 0; idx < season.divisions.length; idx++) {
    const d = season.divisions[idx]!;
    const members = d.members.map((m) => m.player);
    if (members.length < 2) continue;
    divisionsWithSchedule++;

    // SoS balancing needs an MMR per player; unseeded fall back to the division
    // average so they don't skew the balance.
    const seeded = members.map((m) => m.hiddenMmr).filter((x): x is number => x != null);
    const avg = seeded.length ? Math.round(seeded.reduce((a, b) => a + b, 0) / seeded.length) : 1000;
    const sp = members.map((m) => ({ id: m.id, mmr: m.hiddenMmr ?? avg }));

    // Format: the division's own setting if it has one, else the season default
    // (top N divisions are round-robin). Round-robin = play everyone; else a
    // balanced 4-opponent graph (collapses to round-robin if the division is ≤ 5).
    const roundRobin = d.roundRobin ?? idx < rules.roundRobinTopDivisions;
    const degree = roundRobin ? members.length - 1 : 4;
    const { opponents } = generateSchedule(sp, { degree, seed: 1 });

    // Dedupe to canonical pairs (A.id < B.id, matching the Match convention).
    const pairs = new Set<string>();
    for (const [pid, opps] of opponents) {
      for (const opp of opps) {
        const [a, b] = pid < opp ? [pid, opp] : [opp, pid];
        pairs.add(`${a}|${b}`);
      }
    }

    for (const key of pairs) {
      const [a, b] = key.split("|") as [string, string];
      const existing = await prisma.match.findFirst({
        where: { divisionId: d.id, playerAId: a, playerBId: b, format: "LEAGUE_BO2" },
        select: { id: true },
      });
      if (existing) continue; // never clobber an existing / played match
      await prisma.match.create({
        data: { divisionId: d.id, playerAId: a, playerBId: b, format: "LEAGUE_BO2", status: "PENDING", gamesWonA: 0, gamesWonB: 0 },
      });
      created++;
    }
  }

  // Mark the season as schedule-locked — the single source of truth every
  // consumer reads (instead of sniffing for a 0-0 PENDING row). Set whenever any
  // division has a schedule, so a re-run also backfills the flag idempotently.
  if (divisionsWithSchedule > 0) {
    await prisma.season.update({ where: { id: seasonId }, data: { scheduleLocked: true } });
  }

  return { created, divisions: divisionsWithSchedule };
}

// Regenerate ONE division's schedule (round-robin or 4-opponent graph per the
// current rules + the division's ladder position). Lets a rule/MMR change be
// applied to a single division without rebuilding the rest of the season. The
// caller deletes that division's pre-created matches first.
export async function lockOneDivision(divisionId: string): Promise<number> {
  const rules = await getPlacementRules();
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: {
      seasonId: true,
      roundRobin: true,
      members: { where: { status: "ACTIVE" }, select: { player: { select: { id: true, hiddenMmr: true } } } },
    },
  });
  if (!division) return 0;
  const members = division.members.map((m) => m.player);
  if (members.length < 2) return 0;

  // Ladder index = this division's position among the season's divisions (tier
  // position, then group) — drives round-robin (top N) vs 4-opponent graph.
  const ladder = await prisma.division.findMany({
    where: { seasonId: division.seasonId },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
    select: { id: true },
  });
  const idx = ladder.findIndex((d) => d.id === divisionId);

  const seeded = members.map((m) => m.hiddenMmr).filter((x): x is number => x != null);
  const avg = seeded.length ? Math.round(seeded.reduce((a, b) => a + b, 0) / seeded.length) : 1000;
  const sp = members.map((m) => ({ id: m.id, mmr: m.hiddenMmr ?? avg }));
  const roundRobin = division.roundRobin ?? (idx >= 0 && idx < rules.roundRobinTopDivisions);
  const degree = roundRobin ? members.length - 1 : 4;
  const { opponents } = generateSchedule(sp, { degree, seed: 1 });

  const pairs = new Set<string>();
  for (const [pid, opps] of opponents) {
    for (const opp of opps) {
      const [a, b] = pid < opp ? [pid, opp] : [opp, pid];
      pairs.add(`${a}|${b}`);
    }
  }
  let created = 0;
  for (const key of pairs) {
    const [a, b] = key.split("|") as [string, string];
    const existing = await prisma.match.findFirst({
      where: { divisionId, playerAId: a, playerBId: b, format: "LEAGUE_BO2" },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.match.create({
      data: { divisionId, playerAId: a, playerBId: b, format: "LEAGUE_BO2", status: "PENDING", gamesWonA: 0, gamesWonB: 0 },
    });
    created++;
  }
  // This division now has a pre-created schedule → the season is schedule-locked.
  await prisma.season.update({ where: { id: division.seasonId }, data: { scheduleLocked: true } });
  return created;
}
