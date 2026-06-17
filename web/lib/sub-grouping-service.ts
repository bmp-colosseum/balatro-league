import "server-only";

// Web service layer for division sub-grouping — mirrors src/sub-group-service.ts
// but on the web's prisma. Pure compute is the synced engine (@/lib/sub-grouping,
// source of truth in src/). The admin season-build UI calls preview/apply here.

import { prisma } from "@/lib/prisma";
import { balanceSubGroups, summariseBalance, type GroupBalance } from "@/lib/sub-grouping";

export interface DivisionSubGroupPlan {
  divisionId: string;
  divisionName: string;
  memberCount: number;
  groupCount: number;
  balance: GroupBalance[];
  assignments: { memberId: string; playerId: string; playerName: string; seed: number; group: number }[];
}

// Compute the balanced sub-grouping for one division WITHOUT writing — for the
// admin preview. Members are read in admin draft-seed order; the snake-balance
// distributes that seed across groups.
export async function previewDivisionSubGroups(
  divisionId: string,
  groupSize: number,
): Promise<DivisionSubGroupPlan> {
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    include: {
      members: {
        where: { status: "ACTIVE" },
        include: { player: { select: { id: true, displayName: true } } },
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
  const seeds = members.map((_, i) => i + 1);
  return {
    divisionId,
    divisionName: division.name,
    memberCount: members.length,
    groupCount,
    balance: summariseBalance(groups, seeds),
    assignments: members.map((m, i) => ({
      memberId: m.id,
      playerId: m.player.id,
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

// Preview/apply across every division in a season.
export async function planSeasonSubGroups(
  seasonId: string,
  groupSize: number,
  opts: { apply: boolean },
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

export type { GroupBalance };
