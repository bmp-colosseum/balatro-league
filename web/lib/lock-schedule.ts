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

export async function lockDivisionSchedules(seasonId: string): Promise<{ created: number; divisions: number }> {
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

    // Legendary (0) + Rare 1 (1) play a full round-robin; everyone else gets a
    // balanced 4-opponent graph (or round-robin if the division is ≤ 5).
    const degree = idx <= 1 ? members.length - 1 : 4;
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

  return { created, divisions: divisionsWithSchedule };
}
