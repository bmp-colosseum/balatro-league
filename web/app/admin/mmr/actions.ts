"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { seedMissingMmrFromBmp, setPlayerMmr } from "@/lib/mmr-admin";
import { applyRecomputedMmr } from "@/lib/mmr-recompute";

// Flip live MMR on/off. Off = preview-only (the sweep won't auto-apply matches);
// on = hands-off (every confirmed match updates MMR via the sweep).
export async function setLiveMmr(formData: FormData) {
  const { user } = await requireAdmin();
  const enable = String(formData.get("enable")) === "true";
  await prisma.leagueConfig.upsert({
    where: { key: "live_mmr_enabled" },
    create: { key: "live_mmr_enabled", value: enable ? "true" : "false", updatedBy: user.discordId },
    update: { value: enable ? "true" : "false", updatedBy: user.discordId },
  });
  revalidatePath("/admin/mmr");
}

export async function fillMissingMmr() {
  await requireAdmin();
  await seedMissingMmrFromBmp();
  revalidatePath("/admin/mmr");
}

// Replay every confirmed match through Elowen from a BMP seed — sets everyone's
// MMR from their actual results. Overwrites all hidden MMRs (data-driven).
export async function recomputeMmr() {
  await requireAdmin();
  await applyRecomputedMmr();
  revalidatePath("/admin/mmr");
}

// Apply the ladder: write each player's hidden MMR from a precomputed map. The
// client decides the values — SEEDED players (those with a BMP basis) get the
// even −10 spacing by rank; UNSEEDED players all get null (no MMR), so they're
// tied at the base instead of being fake-ranked alphabetically. null clears.
export async function applyMmrLadder(formData: FormData) {
  await requireAdmin();
  let values: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(formData.get("values") ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const entries = Object.entries(values);
  if (entries.length === 0) return;
  await prisma.$transaction(
    entries.map(([playerId, raw]) => {
      const n = raw == null ? null : Math.max(0, Math.floor(Number(raw)));
      const mmr = n != null && Number.isFinite(n) ? n : null;
      return prisma.player.update({ where: { id: playerId }, data: { hiddenMmr: mmr } });
    }),
  );
  revalidatePath("/admin/mmr");
}

// Bulk-save: the form submits one `mmr:<playerId>` field per row. Blank clears
// it (back to unset); a number sets it. Only writes rows that actually changed
// is overkill here — just upsert each provided value.
export async function saveMmrs(formData: FormData) {
  await requireAdmin();
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("mmr:")) continue;
    const playerId = key.slice(4);
    const str = String(raw).trim();
    if (str === "") {
      await setPlayerMmr(playerId, null);
      continue;
    }
    const n = Number.parseInt(str, 10);
    if (Number.isFinite(n)) await setPlayerMmr(playerId, Math.max(0, n));
  }
  revalidatePath("/admin/mmr");
}
