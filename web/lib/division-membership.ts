// Shared helper: place a player into a division, ensuring they're not
// also in any other division in the same season. Existing-elsewhere
// memberships are deleted (transfer semantics) — a player has at most
// one DivisionMember per season at any time.
//
// All add-to-division code paths should go through this. There's no
// DB-level unique constraint enforcing one-per-season; this function
// is the only thing keeping it true.

import { prisma } from "@/lib/prisma";

export interface PlaceResult {
  transferred: boolean;            // true if we removed an existing membership in another division
  previousDivisionName?: string;   // if transferred, the division they came from
}

export async function placePlayerInDivision(
  divisionId: string,
  playerId: string,
): Promise<PlaceResult> {
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { id: true, seasonId: true },
  });
  if (!division) throw new Error(`Division ${divisionId} not found`);

  // Find any OTHER division in the same season the player already belongs to
  const existing = await prisma.divisionMember.findFirst({
    where: {
      playerId,
      division: { seasonId: division.seasonId },
      NOT: { divisionId: division.id },
    },
    include: { division: { select: { name: true } } },
  });

  let result: PlaceResult = { transferred: false };
  if (existing) {
    await prisma.divisionMember.delete({ where: { id: existing.id } });
    result = { transferred: true, previousDivisionName: existing.division.name };
  }

  await prisma.divisionMember.upsert({
    where: { divisionId_playerId: { divisionId: division.id, playerId } },
    create: { divisionId: division.id, seasonId: division.seasonId, playerId, status: "ACTIVE" },
    update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
  });

  return result;
}
