// Service layer for division sub-grouping. Reads a division's seeded members,
// runs the balanced sub-grouping engine, and (optionally) writes the result to
// DivisionMember.assignmentGroup. Pure compute lives in sub-grouping.ts; this
// is the DB wiring the admin command / web preview call.

import { prisma } from "./db.js";
import { balanceSubGroups, summariseBalance, type GroupBalance } from "./sub-grouping.js";

export interface DivisionSubGroupPlan {
  divisionId: string;
  divisionName: string;
  memberCount: number;
  groupCount: number;
  balance: GroupBalance[];
  assignments: { memberId: string; playerName: string; seed: number; group: number }[];
}

// Compute the balanced sub-grouping for one division WITHOUT writing it — for
// the admin preview. Members are taken in their admin draft-seed order, which
// is the within-division seed the snake-balance distributes across groups.
export async function previewDivisionSubGroups(
  divisionId: string,
  groupSize: number,
): Promise<DivisionSubGroupPlan> {
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    include: {
      members: {
        where: { status: "ACTIVE" },
        include: { player: { select: { displayName: true } } },
        orderBy: [{ draftOrder: "asc" }, { seedRank: "asc" }],
      },
    },
  });
  if (!division) throw new Error(`Division ${divisionId} not found`);

  const members = division.members;
  const { groups, groupCount } = balanceSubGroups(
    members.map((m) => m.id),
    groupSize,
  );
  // Seed = 1-based position in the ordered list (relative order is all the
  // balance summary needs).
  const seeds = members.map((_, i) => i + 1);
  return {
    divisionId,
    divisionName: division.name,
    memberCount: members.length,
    groupCount,
    balance: summariseBalance(groups, seeds),
    assignments: members.map((m, i) => ({
      memberId: m.id,
      playerName: m.player.displayName,
      seed: i + 1,
      group: groups[i]!,
    })),
  };
}

// Compute AND persist the sub-grouping for one division.
export async function applyDivisionSubGroups(
  divisionId: string,
  groupSize: number,
): Promise<DivisionSubGroupPlan> {
  const plan = await previewDivisionSubGroups(divisionId, groupSize);
  await prisma.$transaction(
    plan.assignments.map((a) =>
      prisma.divisionMember.update({
        where: { id: a.memberId },
        data: { assignmentGroup: a.group },
      }),
    ),
  );
  return plan;
}

// Apply across every division in a season — the build-time / one-shot path the
// admin command uses. Returns one plan per division.
export async function applySeasonSubGroups(
  seasonId: string,
  groupSize: number,
  opts: { apply: boolean } = { apply: true },
): Promise<DivisionSubGroupPlan[]> {
  const divisions = await prisma.division.findMany({
    where: { seasonId },
    select: { id: true },
    orderBy: { name: "asc" },
  });
  const run = opts.apply ? applyDivisionSubGroups : previewDivisionSubGroups;
  const plans: DivisionSubGroupPlan[] = [];
  for (const d of divisions) {
    plans.push(await run(d.id, groupSize));
  }
  return plans;
}
