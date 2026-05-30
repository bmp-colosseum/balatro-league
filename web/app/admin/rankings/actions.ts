"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export async function setRating(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const ratingStr = String(formData.get("rating") ?? "").trim();
  const note = String(formData.get("ratingNote") ?? "").trim() || null;
  if (!playerId) return;
  const rating = ratingStr === "" ? null : parseInt(ratingStr, 10);
  if (rating !== null && Number.isNaN(rating)) return;
  await prisma.player.update({ where: { id: playerId }, data: { rating, ratingNote: note } });
  revalidatePath("/admin/rankings");
}

export async function bulkRatings(formData: FormData) {
  await requireAdmin();
  const lines = String(formData.get("lines") ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    const id = parts[0] ?? "";
    const ratingStr = parts[1] ?? "";
    const note = parts.slice(2).join(",").trim() || null;
    const rating = parseInt(ratingStr, 10);
    if (Number.isNaN(rating)) continue;
    const player = /^\d{17,20}$/.test(id)
      ? await prisma.player.findUnique({ where: { discordId: id } })
      : await prisma.player.findFirst({ where: { displayName: id } });
    if (!player) continue;
    await prisma.player.update({ where: { id: player.id }, data: { rating, ratingNote: note } });
  }
  revalidatePath("/admin/rankings");
}
