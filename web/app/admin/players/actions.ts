"use server";

// Server actions for /admin/players. Called from forms.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

const MOCK_PREFIX = "mock-";

export async function addFakePlayer(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const divisionId = String(formData.get("divisionId") ?? "").trim();
  if (!name) return;

  const discordId = `${MOCK_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const player = await prisma.player.create({
    data: { discordId, displayName: name },
  });

  if (divisionId) {
    const div = await prisma.division.findUnique({
      where: { id: divisionId },
      include: { season: true, _count: { select: { members: true } } },
    });
    if (div && div._count.members < (div.targetSize ?? div.season.targetGroupSize)) {
      await prisma.divisionMember.create({
        data: { divisionId: div.id, playerId: player.id },
      });
    }
  }
  revalidatePath("/admin/players");
}

// Move a player into/out of a division. divisionId encodes which season,
// so this works for any season (not just the active one). Empty divisionId
// = remove from whatever division(s) they're in for that season.
export async function movePlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const divisionId = String(formData.get("divisionId") ?? "").trim();
  if (!playerId) return;

  if (divisionId) {
    const div = await prisma.division.findUnique({
      where: { id: divisionId },
      include: { season: true },
    });
    if (!div) return;
    // Remove from any other division in the same season first
    await prisma.divisionMember.deleteMany({
      where: { playerId, division: { seasonId: div.seasonId }, NOT: { divisionId: div.id } },
    });
    const count = await prisma.divisionMember.count({ where: { divisionId: div.id } });
    if (count < (div.targetSize ?? div.season.targetGroupSize)) {
      await prisma.divisionMember.upsert({
        where: { divisionId_playerId: { divisionId: div.id, playerId } },
        create: { divisionId: div.id, playerId, status: "ACTIVE" },
        update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
      });
    }
  } else {
    // Empty divisionId = remove from active season (preserves old behavior for the "— remove —" option)
    const active = await prisma.season.findFirst({ where: { isActive: true } });
    if (active) {
      await prisma.divisionMember.deleteMany({
        where: { playerId, division: { seasonId: active.id } },
      });
    }
  }
  revalidatePath("/admin/players");
}

export async function dropPlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season || !playerId) return;

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId: season.id }, status: "ACTIVE" },
  });
  if (!membership) return;

  await prisma.divisionMember.update({
    where: { id: membership.id },
    data: { status: "DROPPED", droppedAt: new Date() },
  });

  // Void unplayed pairings
  await prisma.pairing.deleteMany({
    where: {
      divisionId: membership.divisionId,
      status: "PENDING",
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  revalidatePath("/admin/players");
}

export async function reinstatePlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season || !playerId) return;

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId: season.id }, status: "DROPPED" },
  });
  if (membership) {
    await prisma.divisionMember.update({
      where: { id: membership.id },
      data: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
    });
  }
  revalidatePath("/admin/players");
}

export async function deletePlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  if (!playerId) return;
  await prisma.pairing.deleteMany({
    where: { OR: [{ playerAId: playerId }, { playerBId: playerId }] },
  });
  await prisma.player.delete({ where: { id: playerId } });
  revalidatePath("/admin/players");
}
