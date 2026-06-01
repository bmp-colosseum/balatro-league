"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { isCanonicalDeck, isCanonicalStake } from "@/lib/balatro-info";
import defaults from "@/lib/match-defaults.json";

const DEFAULT_PRESET_NAME = "Default";

// Any change to MatchConfigPreset (create, rename, delete, edit
// decks/stakes) needs to bust the cached preset list on every
// surface that renders it. Without this, an admin who creates a
// preset on /admin/deck-bans wouldn't see it in /admin/seasons or
// the per-season picker until the page's revalidate window expires.
function revalidatePresetSurfaces() {
  revalidatePresetSurfaces();
  revalidatePath("/admin/seasons");
  // The per-season picker lives on every season detail page.
  // Layout-level revalidation invalidates all of them.
  revalidatePath("/admin/seasons", "layout");
}

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
  revalidatePresetSurfaces();
  redirect(`/admin/deck-bans?preset=${preset.id}`);
}

export async function renamePreset(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  await prisma.matchConfigPreset.update({ where: { id }, data: { name } });
  revalidatePresetSurfaces();
}

export async function deletePreset(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  // Season.matchConfigPresetId is ON DELETE SET NULL — any season pointing
  // at this preset will fall back to the Default preset at match-time.
  await prisma.matchConfigPreset.delete({ where: { id } });
  revalidatePresetSurfaces();
  redirect("/admin/deck-bans");
}

export async function addDeck(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  // Only canonical decks (defined in src/data/balatro-info.json) are valid —
  // prevents typos from creating phantom decks the ban menu can't describe.
  if (!isCanonicalDeck(name)) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  if (preset.decks.includes(name)) return;
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { decks: [...preset.decks, name] },
  });
  revalidatePresetSurfaces();
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
  revalidatePresetSurfaces();
}

export async function addStake(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  if (!isCanonicalStake(name)) return;
  const preset = await prisma.matchConfigPreset.findUniqueOrThrow({ where: { id } });
  if (preset.stakes.includes(name)) return;
  await prisma.matchConfigPreset.update({
    where: { id },
    data: { stakes: [...preset.stakes, name] },
  });
  revalidatePresetSurfaces();
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
  revalidatePresetSurfaces();
}

// Bootstrap action — creates the Default preset on demand if none exists.
export async function seedDefaultPreset() {
  await requireAdmin();
  const existing = await prisma.matchConfigPreset.findUnique({
    where: { name: DEFAULT_PRESET_NAME },
  });
  if (existing) {
    revalidatePresetSurfaces();
    redirect(`/admin/deck-bans?preset=${existing.id}`);
  }
  const created = await prisma.matchConfigPreset.create({
    data: { name: DEFAULT_PRESET_NAME, decks: defaults.decks, stakes: defaults.stakes },
  });
  revalidatePresetSurfaces();
  redirect(`/admin/deck-bans?preset=${created.id}`);
}
