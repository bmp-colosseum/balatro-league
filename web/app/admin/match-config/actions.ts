"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
// Synced from src/data/match-defaults.json by web/scripts/sync-schema.mjs (postinstall).
import defaults from "@/lib/match-defaults.json";

export async function addDeck(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await prisma.allowedDeck.upsert({
    where: { name },
    create: { name },
    update: {},
  });
  revalidatePath("/admin/match-config");
}

export async function removeDeck(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await prisma.allowedDeck.delete({ where: { id } });
  revalidatePath("/admin/match-config");
}

export async function addStake(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await prisma.allowedStake.upsert({
    where: { name },
    create: { name },
    update: {},
  });
  revalidatePath("/admin/match-config");
}

export async function removeStake(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await prisma.allowedStake.delete({ where: { id } });
  revalidatePath("/admin/match-config");
}

export async function seedDefaults() {
  await requireAdmin();
  const [deckCount, stakeCount] = await Promise.all([
    prisma.allowedDeck.count(),
    prisma.allowedStake.count(),
  ]);
  if (deckCount === 0) {
    await prisma.allowedDeck.createMany({ data: defaults.decks.map((name) => ({ name })) });
  }
  if (stakeCount === 0) {
    await prisma.allowedStake.createMany({ data: defaults.stakes.map((name) => ({ name })) });
  }
  revalidatePath("/admin/match-config");
}
