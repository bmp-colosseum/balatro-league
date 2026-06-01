"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { enqueueMmrSnapshot } from "@/lib/queue";

export async function setRating(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const ratingStr = String(formData.get("rating") ?? "").trim();
  if (!playerId) return;
  const rating = ratingStr === "" ? null : parseInt(ratingStr, 10);
  if (rating !== null && Number.isNaN(rating)) return;
  // ratingNote isn't in the rankings UI anymore. Only update it when
  // the form explicitly includes the field (e.g. from bulkRatings),
  // so removing the input doesn't wipe any existing notes set elsewhere.
  const noteRaw = formData.get("ratingNote");
  const data: { rating: number | null; ratingNote?: string | null } = { rating };
  if (noteRaw !== null) {
    data.ratingNote = String(noteRaw).trim() || null;
  }
  await prisma.player.update({ where: { id: playerId }, data });
  revalidatePath("/admin/rankings");
}

// Manual trigger for the same fanout the daily cron does — enqueue a
// fresh snapshot.mmr for every active-season member. Same scope as the
// 12:00 UTC cron in src/queue.ts on purpose: we don't refresh past-
// season players because their snapshots are historical and immutable.
export async function refreshActiveSeasonMmrs() {
  await requireAdmin();
  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true, endedAt: null },
    orderBy: { startedAt: "desc" },
    include: {
      divisions: {
        include: {
          members: {
            where: { status: "ACTIVE" },
            include: { player: { select: { discordId: true } } },
          },
        },
      },
    },
  });
  if (!activeSeason) return;
  const seen = new Set<string>();
  for (const div of activeSeason.divisions) {
    for (const m of div.members) {
      if (seen.has(m.player.discordId)) continue;
      seen.add(m.player.discordId);
      await enqueueMmrSnapshot({ discordId: m.player.discordId, seasonId: activeSeason.id }).catch(
        (err) => console.warn(`[admin-refresh-mmr] enqueue failed for ${m.player.discordId}:`, err),
      );
    }
  }
  console.log(`[admin-refresh-mmr] queued ${seen.size} for active season ${activeSeason.id}`);
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
