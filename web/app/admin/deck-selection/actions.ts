"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import defaults from "@/lib/match-defaults.json";

const DEFAULT_PRESET_NAME = "Default";

export async function createPreset(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const seedDefaults = String(formData.get("seedDefaults") ?? "") === "on";
  if (!name) return;
  const preset = await prisma.matchConfigPreset.create({
    data: {
      name,
      decks: seedDefaults ? defaults.decks : [],
      stakes: seedDefaults ? defaults.stakes : [],
    },
  });
  revalidatePath("/admin/deck-selection");
  redirect(`/admin/deck-selection?preset=${preset.id}`);
}

export async function renamePreset(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  await prisma.matchConfigPreset.update({ where: { id }, data: { name } });
  revalidatePath("/admin/deck-selection");
}

export async function deletePreset(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  // Season.matchConfigPresetId is ON DELETE SET NULL â€” any season pointing
  // at this preset will fall back to the Default preset at match-time.
  await prisma.matchConfigPreset.delete({ where: { id } });
  revalidatePath("/admin/deck-selection");
  redirect("/admin/deck-selection");
}

export async function addDeck(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  if (preset.decks.includes(name)) return;
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { decks: [...preset.decks, name] },
  });
  revalidatePath("/admin/deck-selection");
}

export async function removeDeck(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!id || !name) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { decks: preset.decks.filter((d) => d !== name) },
  });
  revalidatePath("/admin/deck-selection");
}

export async function addStake(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  if (preset.stakes.includes(name)) return;
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { stakes: [...preset.stakes, name] },
  });
  revalidatePath("/admin/deck-selection");
}

export async function removeStake(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!id || !name) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { stakes: preset.stakes.filter((s) => s !== name) },
  });
  revalidatePath("/admin/deck-selection");
}

// Bootstrap action â€” creates the Default preset on demand if none exists.
export async function seedDefaultPreset() {
  await requireAdmin();
  const existing = await prisma.matchConfigPreset.findUnique({
    where: { name: DEFAULT_PRESET_NAME },
  });
  if (existing) {
    revalidatePath("/admin/deck-selection");
    redirect(`/admin/deck-selection?preset=${existing.id}`);
  }
  const created = await prisma.matchConfigPreset.create({
    data: { name: DEFAULT_PRESET_NAME, decks: defaults.decks, stakes: defaults.stakes },
  });
  revalidatePath("/admin/deck-selection");
  redirect(`/admin/deck-selection?preset=${created.id}`);
}
