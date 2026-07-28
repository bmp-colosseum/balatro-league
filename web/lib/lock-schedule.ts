import "server-only";

// Lock in each division's schedule at activation: generate the assigned-opponent
// graph (each division's own opponents-per-player count, or the season default,
// clamped to size-1) and persist it as PENDING 0-0 Match rows. After this, "your schedule" is real data
// — and because reporting find-or-creates a match by (division, players, format),
// a report just UPDATES the pre-created row, so nothing about /start-match or
// reporting breaks. Idempotent: existing matches (incl. already-played ones) are
// never touched.

import { prisma } from "@/lib/prisma";
import { generateSchedule, scheduleDegree } from "@/lib/schedule";
import { getPlacementRules } from "@/lib/placement-rules";
import { loadAvoidedPairIdPairs } from "@/lib/loaders/avoided-pairs";

// Resolve the "never pair these two" blocklist into ready-to-show warnings for
// the divisions where it couldn't be honored (a full round-robin can't drop any
// edge). Only queries player names when something was actually unavoidable.
async function describeUnavoidable(
  pairs: Array<{ divisionName: string; a: string; b: string }>,
): Promise<string[]> {
  if (pairs.length === 0) return [];
  const ids = [...new Set(pairs.flatMap((u) => [u.a, u.b]))];
  const players = await prisma.player.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));
  return pairs.map(
    (u) => `${u.divisionName}: ${nameById.get(u.a) ?? u.a} & ${nameById.get(u.b) ?? u.b} (full round-robin -- can't separate)`,
  );
}

export async function lockDivisionSchedules(
  seasonId: string,
): Promise<{ created: number; divisions: number; unavoidable: string[] }> {
  const rules = await getPlacementRules();
  const forbidden = await loadAvoidedPairIdPairs();
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
  if (!season) return { created: 0, divisions: 0, unavoidable: [] };

  let created = 0;
  let divisionsWithSchedule = 0;
  const unavoidablePairs: Array<{ divisionName: string; a: string; b: string }> = [];

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

    // Format: the division's own opponents-per-player setting, or the season
    // default, clamped to size-1 (so a division at or above that count plays a
    // full round-robin, and small divisions collapse to round-robin automatically).
    const degree = scheduleDegree(d.opponentsPerPlayer, rules.defaultOpponentsPerPlayer, members.length);
    const { opponents, unavoidable } = generateSchedule(sp, { degree, seed: 1, forbidden });
    for (const [a, b] of unavoidable) unavoidablePairs.push({ divisionName: d.name, a, b });

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

  return {
    created,
    divisions: divisionsWithSchedule,
    unavoidable: await describeUnavoidable(unavoidablePairs),
  };
}

// Regenerate ONE division's schedule (its own opponents-per-player setting, or
// the season default, per scheduleDegree). Lets a rule/MMR change be applied to
// a single division without rebuilding the rest of the season. The caller
// deletes that division's pre-created matches first.
export async function lockOneDivision(divisionId: string): Promise<number> {
  const rules = await getPlacementRules();
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: {
      seasonId: true,
      opponentsPerPlayer: true,
      members: { where: { status: "ACTIVE" }, select: { player: { select: { id: true, hiddenMmr: true } } } },
    },
  });
  if (!division) return 0;
  const members = division.members.map((m) => m.player);
  if (members.length < 2) return 0;

  const seeded = members.map((m) => m.hiddenMmr).filter((x): x is number => x != null);
  const avg = seeded.length ? Math.round(seeded.reduce((a, b) => a + b, 0) / seeded.length) : 1000;
  const sp = members.map((m) => ({ id: m.id, mmr: m.hiddenMmr ?? avg }));
  const degree = scheduleDegree(division.opponentsPerPlayer, rules.defaultOpponentsPerPlayer, members.length);
  const forbidden = await loadAvoidedPairIdPairs();
  const { opponents, unavoidable } = generateSchedule(sp, { degree, seed: 1, forbidden });
  if (unavoidable.length) {
    console.warn(`[lock-schedule] division ${divisionId} can't separate ${unavoidable.length} avoided pair(s) (full round-robin)`);
  }

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
