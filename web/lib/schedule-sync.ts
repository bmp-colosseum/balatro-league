import "server-only";

// Repair a locked season's pre-created schedule after a mid-season roster change
// (move / add / drop). For each division: prune unplayed (PENDING 0-0) matches
// that now involve a non-member, then fill every active member up to their target
// opponent count — preserving every existing (played or still-valid) match, so
// nobody's current schedule is disturbed. No-op on seasons that aren't schedule-
// locked (legacy on-demand round-robin). Idempotent: safe to call after every
// roster action and to expose as a manual "re-sync" button.

import { prisma } from "@/lib/prisma";
import { planDivisionResync, type ExistingMatch } from "@/lib/schedule";
import { getPlacementRules } from "@/lib/placement-rules";

export async function resyncSeasonSchedules(seasonId: string): Promise<{ pruned: number; created: number }> {
  // A season has a locked schedule iff the flag is set OR — the ground truth — a
  // pre-created (0-0 PENDING) match exists. We honour either, so a flag that's
  // wrongly false (e.g. a season activated before the flag existed) still gets
  // maintained, and we re-set the flag below so the rest of the app heals. Legacy
  // on-demand seasons have no 0-0 PENDING rows, so they correctly no-op.
  const flag = await prisma.season.findUnique({ where: { id: seasonId }, select: { scheduleLocked: true } });
  const hasPreCreated =
    (await prisma.match.count({
      where: { format: "LEAGUE_BO2", status: "PENDING", gamesWonA: 0, gamesWonB: 0, division: { seasonId } },
    })) > 0;
  if (!flag?.scheduleLocked && !hasPreCreated) return { pruned: 0, created: 0 };

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        select: {
          id: true,
          members: { where: { status: "ACTIVE" }, select: { playerId: true } },
          matches: {
            where: { format: "LEAGUE_BO2" },
            select: { id: true, playerAId: true, playerBId: true, status: true, gamesWonA: true, gamesWonB: true },
          },
        },
      },
    },
  });
  if (!season) return { pruned: 0, created: 0 };
  // Self-heal a stale flag so every consumer that reads season.scheduleLocked
  // (standings, admin match-fixing, /schedule, …) starts filtering correctly.
  if (!flag?.scheduleLocked) {
    await prisma.season.update({ where: { id: seasonId }, data: { scheduleLocked: true } });
  }
  const rules = await getPlacementRules();

  let pruned = 0;
  let created = 0;
  for (let idx = 0; idx < season.divisions.length; idx++) {
    const d = season.divisions[idx]!;
    const memberIds = d.members.map((m) => m.playerId);
    const matches = d.matches as ExistingMatch[];
    // Top divisions play a full round-robin; everyone else a 4-opponent graph.
    // (<2 members → target 0: prune-only, no pairs to make.)
    const target = memberIds.length < 2 ? 0 : idx < rules.roundRobinTopDivisions ? memberIds.length - 1 : 4;
    const plan = planDivisionResync(memberIds, matches, target);

    if (plan.pruneIds.length) {
      await prisma.match.deleteMany({ where: { id: { in: plan.pruneIds } } });
      pruned += plan.pruneIds.length;
    }
    if (plan.createPairs.length) {
      await prisma.match.createMany({
        data: plan.createPairs.map(([a, b]) => ({
          divisionId: d.id,
          playerAId: a,
          playerBId: b,
          format: "LEAGUE_BO2" as const,
          status: "PENDING" as const,
          gamesWonA: 0,
          gamesWonB: 0,
        })),
        skipDuplicates: true,
      });
      created += plan.createPairs.length;
    }
  }
  return { pruned, created };
}
