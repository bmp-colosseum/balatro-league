// Shared helper: place a player into a division, ensuring they're not
// also in any other division in the same season. Existing-elsewhere
// memberships are deleted (transfer semantics) — a player has at most
// one DivisionMember per season at any time.
//
// All add-to-division code paths should go through this. There's a
// DB unique constraint (seasonId, playerId) that hard-enforces the rule;
// this function is what makes the user-facing semantics 'transfer' rather
// than 'error'.
//
// Also handles Discord role bookkeeping — strips the previous division's
// role from the player when a transfer happens, so they only carry the
// role of their current division.

import { prisma } from "@/lib/prisma";
import { removeGuildMemberRole } from "@/lib/discord";

export interface PlaceResult {
  transferred: boolean;            // true if we removed an existing membership in another division
  previousDivisionName?: string;   // if transferred, the division they came from
  previousRoleRemoved?: boolean;   // true if we also stripped the previous division's Discord role
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
    include: {
      division: { select: { name: true, discordRoleId: true } },
      player: { select: { discordId: true } },
    },
  });

  let result: PlaceResult = { transferred: false };
  if (existing) {
    await prisma.divisionMember.delete({ where: { id: existing.id } });
    let previousRoleRemoved = false;
    const guildId = process.env.DISCORD_GUILD_ID;
    if (guildId && existing.division.discordRoleId) {
      previousRoleRemoved = await removeGuildMemberRole(
        guildId,
        existing.player.discordId,
        existing.division.discordRoleId,
      );
    }
    result = {
      transferred: true,
      previousDivisionName: existing.division.name,
      previousRoleRemoved,
    };
  }

  // Place newly-added members at the END of the target division's
  // draftOrder sequence so the draft UI gets a deterministic position
  // (and so they don't collide with the default 0 on existing rows).
  // Only set draftOrder on CREATE — moving an existing member here
  // (via the late-add form re-adding a player) should keep their
  // current position, since this code path isn't the positional drag.
  const maxOrderRow = await prisma.divisionMember.findFirst({
    where: { divisionId: division.id },
    orderBy: { draftOrder: "desc" },
    select: { draftOrder: true },
  });
  const nextOrder = (maxOrderRow?.draftOrder ?? 0) + 1;

  await prisma.divisionMember.upsert({
    where: { divisionId_playerId: { divisionId: division.id, playerId } },
    create: {
      divisionId: division.id,
      seasonId: division.seasonId,
      playerId,
      status: "ACTIVE",
      draftOrder: nextOrder,
    },
    update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
  });

  return result;
}
