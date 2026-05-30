"use server";

// Server actions for /admin/players. Called from forms.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

const MOCK_PREFIX = "mock-";

export async function addFakePlayer(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const divisionName = String(formData.get("divisionName") ?? "").trim();
  if (!name) return;

  const discordId = `${MOCK_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const player = await prisma.player.create({
    data: { discordId, displayName: name },
  });

  if (divisionName) {
    const season = await prisma.season.findFirst({ where: { isActive: true } });
    if (season) {
      const div = await prisma.division.findFirst({
        where: { seasonId: season.id, name: divisionName },
        include: { _count: { select: { members: true } } },
      });
      if (div && div._count.members < (div.targetSize ?? season.targetGroupSize)) {
        await prisma.divisionMember.create({
          data: { divisionId: div.id, playerId: player.id },
        });
      }
    }
  }
  revalidatePath("/admin/players");
}

export async function movePlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const divisionName = String(formData.get("divisionName") ?? "").trim();
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season || !playerId) return;

  await prisma.divisionMember.deleteMany({
    where: { playerId, division: { seasonId: season.id } },
  });

  if (divisionName) {
    const div = await prisma.division.findFirst({
      where: { seasonId: season.id, name: divisionName },
    });
    if (div) {
      const count = await prisma.divisionMember.count({ where: { divisionId: div.id } });
      if (count < (div.targetSize ?? season.targetGroupSize)) {
        await prisma.divisionMember.create({ data: { divisionId: div.id, playerId } });
      }
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
