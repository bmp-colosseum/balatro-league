"use server";

// Admin-only server actions for the past-season detail page.
// Currently just the final-rank override: admin can correct a
// player's finalGlobalRank for a given season (and, if this is the
// most-recent ended season, propagate the change to Player.rating
// so it flows into the next season's build).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

export async function setFinalGlobalRank(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "").trim();
  const playerId = String(formData.get("playerId") ?? "").trim();
  const rawRank = String(formData.get("rank") ?? "").trim();
  if (!seasonId || !playerId) {
    redirect(`/seasons/${seasonId}?err=missing-fields`);
  }

  const rank = rawRank === "" ? null : Number.parseInt(rawRank, 10);
  if (rank !== null && (!Number.isFinite(rank) || rank < 1)) {
    redirect(`/seasons/${seasonId}?err=${encodeURIComponent("Rank must be a positive integer or blank")}`);
  }

  const member = await prisma.divisionMember.findFirst({
    where: { seasonId, playerId },
    select: { id: true, finalGlobalRank: true, player: { select: { displayName: true } } },
  });
  if (!member) {
    redirect(`/seasons/${seasonId}?err=member-not-found`);
  }

  await prisma.divisionMember.update({
    where: { id: member.id },
    data: { finalGlobalRank: rank },
  });

  // If this season is currently the most-recent ENDED season, the
  // edit should also flow into Player.rating so next season's build
  // picks it up. Older seasons just update the historical record.
  const mostRecentEnded = await prisma.season.findFirst({
    where: { isActive: false, endedAt: { not: null } },
    orderBy: { endedAt: "desc" },
    select: { id: true },
  });
  let alsoUpdatedPlayer = false;
  if (mostRecentEnded?.id === seasonId) {
    await prisma.player.update({
      where: { id: playerId },
      data: { rating: rank },
    });
    alsoUpdatedPlayer = true;
  }

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.set-final-rank",
    targetType: "DivisionMember",
    targetId: member.id,
    summary: `Set ${member.player.displayName}'s final rank to ${rank ?? "—"} for season ${seasonId}${alsoUpdatedPlayer ? " (also synced to current Player.rating)" : ""}`,
    metadata: { seasonId, playerId, oldRank: member.finalGlobalRank, newRank: rank, alsoUpdatedPlayer },
  });

  revalidatePath(`/seasons/${seasonId}`);
  redirect(`/seasons/${seasonId}?ok=1`);
}
