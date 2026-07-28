"use server";

// Server actions for /admin/avoided-pairs -- the "never pair these two
// players" blocklist. AvoidedPair stores a CANONICAL pair (playerAId <
// playerBId by string compare) so the @@unique constraint catches a
// duplicate regardless of which order the admin picked the two players in.

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import type { ActionResult } from "@/lib/action-result";

const PAGE_PATH = "/admin/avoided-pairs";

export async function addAvoidedPair(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { user } = await requireAdmin();

  const rawA = String(formData.get("playerAId") ?? "").trim();
  const rawB = String(formData.get("playerBId") ?? "").trim();
  const noteRaw = String(formData.get("note") ?? "").trim();
  const note = noteRaw.length > 0 ? noteRaw : null;

  if (!rawA || !rawB) {
    return { ok: false, message: "Pick both players." };
  }
  if (rawA === rawB) {
    return { ok: false, message: "A player can't be blocked against themselves." };
  }

  // Canonicalize so the stored pair is always (lower id, higher id) -- keeps
  // the @@unique constraint effective no matter which order they were picked.
  const [playerAId, playerBId] = rawA < rawB ? [rawA, rawB] : [rawB, rawA];

  const players = await prisma.player.findMany({
    where: { id: { in: [playerAId, playerBId] } },
    select: { id: true, displayName: true },
  });
  const aName = players.find((p) => p.id === playerAId)?.displayName;
  const bName = players.find((p) => p.id === playerBId)?.displayName;
  if (!aName || !bName) {
    return { ok: false, message: "One of those players couldn't be found." };
  }

  try {
    await prisma.avoidedPair.create({
      data: { playerAId, playerBId, note, createdBy: user.discordId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, message: "Those two are already blocked." };
    }
    throw err;
  }

  revalidatePath(PAGE_PATH);
  return {
    ok: true,
    message: `${aName} and ${bName} will no longer be scheduled against each other.`,
  };
}

export async function removeAvoidedPair(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, message: "Missing pairing." };

  await prisma.avoidedPair.deleteMany({ where: { id } });

  revalidatePath(PAGE_PATH);
  return { ok: true, message: "Removed." };
}
