"use server";

// Server actions for /admin/players. Called from forms.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { announceResult } from "@/lib/announce";
import { placePlayerInDivision } from "@/lib/division-membership";

type Result = "2-0" | "1-1" | "0-2";

function gamesFromResult(r: Result): { a: number; b: number } {
  if (r === "2-0") return { a: 2, b: 0 };
  if (r === "0-2") return { a: 0, b: 2 };
  return { a: 1, b: 1 };
}

// Change a player's Discord ID. Useful when a row was imported with a
// typo or the wrong account ID. Keeps everything else (rating, memberships,
// pairings) intact — they all reference Player.id, not discordId.
export async function setPlayerDiscordId(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const newId = String(formData.get("discordId") ?? "").trim();
  if (!playerId || !newId) return;
  if (!/^\d{17,20}$/.test(newId)) return;

  // Check the new ID isn't already in use by another player
  const collision = await prisma.player.findUnique({ where: { discordId: newId } });
  if (collision && collision.id !== playerId) return; // silently no-op on collision

  await prisma.player.update({
    where: { id: playerId },
    // Also clear the custom-name flag so the next /me visit auto-syncs the
    // new account's actual Discord username (probably what admin wants).
    data: { discordId: newId, hasCustomDisplayName: false },
  });
  revalidatePath("/admin/players");
}

// Admin records a set between two active members of a division. Upserts
// the Pairing as CONFIRMED with this admin's user id stamped on
// adminOverrideBy. Mirrors /admin/divisions/[id] recordSet but invocable
// from the per-player view so admin doesn't have to navigate away.
export async function recordSetForPlayer(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  const opponentId = String(formData.get("opponentId") ?? "");
  const result = String(formData.get("result") ?? "") as Result;
  if (!divisionId || !playerId || !opponentId || !["2-0", "1-1", "0-2"].includes(result)) return;
  if (playerId === opponentId) return;

  const [canonA, canonB] = playerId < opponentId ? [playerId, opponentId] : [opponentId, playerId];
  const playerIsA = playerId === canonA;
  const games = gamesFromResult(result);
  const gamesWonA = playerIsA ? games.a : games.b;
  const gamesWonB = playerIsA ? games.b : games.a;

  const recorded = await prisma.pairing.upsert({
    where: { divisionId_playerAId_playerBId: { divisionId, playerAId: canonA, playerBId: canonB } },
    create: {
      divisionId,
      playerAId: canonA,
      playerBId: canonB,
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      reportedAt: new Date(),
      confirmedAt: new Date(),
      adminOverrideBy: "admin-players-page",
      adminOverrideReason: "recorded via /admin/players",
    },
    update: {
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: "admin-players-page",
      adminOverrideReason: "recorded via /admin/players (overwrite)",
    },
  });
  announceResult(recorded.id).catch(() => {});
  revalidatePath("/admin/players");
  revalidatePath(`/admin/divisions/${divisionId}`);
}

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
      await placePlayerInDivision(div.id, player.id);
    }
  }
  revalidatePath("/admin/players");
}

// Move a player into/out of a division. divisionId encodes which season,
// so this works for any season (not just the active one). Empty divisionId
// = remove from whatever division(s) they're in for that season.
//
// placePlayerInDivision handles the "in any other division this season"
// case automatically (transfers them).
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
    const count = await prisma.divisionMember.count({
      where: { divisionId: div.id, NOT: { playerId } },
    });
    if (count < (div.targetSize ?? div.season.targetGroupSize)) {
      await placePlayerInDivision(div.id, playerId);
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
