"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { TRAIT_REGISTRY } from "@/lib/loaders/player-traits";

const VALID_KEYS = new Set(TRAIT_REGISTRY.map((t) => t.key));

// Empty string → null (clear the override for that field, fall back to the
// code default); otherwise the trimmed value.
function clean(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

export async function saveTrait(formData: FormData) {
  const { user } = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  if (!VALID_KEYS.has(key)) return;

  const label = clean(formData.get("label"));
  const emoji = clean(formData.get("emoji"));
  const description = clean(formData.get("description"));

  // iconDataUrl from the client: "" = leave the existing icon untouched,
  // "__clear__" = remove it, otherwise a resized data: URL to store. Validate
  // shape + cap size so a malformed or oversized blob can't land in the DB
  // (a 48px PNG data URL is only a few KB; 200KB is a generous ceiling).
  const rawIcon = String(formData.get("iconDataUrl") ?? "");
  const iconUpdate: { iconDataUrl?: string | null } = {};
  if (rawIcon === "__clear__") {
    iconUpdate.iconDataUrl = null;
  } else if (rawIcon) {
    if (rawIcon.startsWith("data:image/") && rawIcon.length <= 200_000) {
      iconUpdate.iconDataUrl = rawIcon;
    }
    // else: bad shape / too big → silently ignore, keep whatever's there.
  }

  await prisma.traitOverride.upsert({
    where: { key },
    create: { key, label, emoji, description, updatedBy: user.discordId, ...iconUpdate },
    update: { label, emoji, description, updatedBy: user.discordId, ...iconUpdate },
  });

  const iconState =
    iconUpdate.iconDataUrl === undefined ? "unchanged" : iconUpdate.iconDataUrl ? "set" : "cleared";
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "trait.override",
    targetType: "TraitOverride",
    targetId: key,
    summary: `Edited trait "${label ?? key}"`,
    metadata: { icon: iconState },
  });
  revalidatePath("/admin/traits");
}

export async function resetTrait(formData: FormData) {
  const { user } = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  if (!VALID_KEYS.has(key)) return;
  await prisma.traitOverride.deleteMany({ where: { key } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "trait.reset",
    targetType: "TraitOverride",
    targetId: key,
    summary: `Reset trait "${key}" to defaults`,
  });
  revalidatePath("/admin/traits");
}
