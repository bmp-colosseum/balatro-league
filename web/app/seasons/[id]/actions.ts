"use server";

// Admin-only server actions for the season detail page (public + admin
// surfaces merged). Lifecycle / cross-page actions (createSeason,
// activateSeason, etc.) still live in app/admin/seasons/actions.ts —
// only the detail-page-specific finalGlobalRank override is here.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { planSeasonSubGroups } from "@/lib/sub-grouping-service";

// Set the sub-group size for a season (the size each division is split into
// when you generate). Doesn't regenerate — hit Generate after to apply.
export async function setSubGroupSize(formData: FormData) {
  await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "").trim();
  const size = Number.parseInt(String(formData.get("subGroupSize") ?? ""), 10);
  if (!seasonId) return;
  if (!Number.isFinite(size) || size < 2) {
    redirect(`/seasons/${seasonId}?err=${encodeURIComponent("Sub-group size must be 2 or more")}`);
  }
  await prisma.season.update({ where: { id: seasonId }, data: { subGroupSize: size } });
  revalidatePath(`/seasons/${seasonId}`);
}

// (Re)generate balanced sub-groups for every division in a draft season. Writes
// DivisionMember.assignmentGroup from the current placement/seed order; safe to
// re-run after moving players around. Only meaningful pre-activation — it's the
// "split each division into its match-assignment groups" step before build.
export async function generateSubGroups(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "").trim();
  if (!seasonId) redirect(`/seasons/${seasonId}?err=missing-fields`);

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { subGroupSize: true },
  });
  if (!season) redirect(`/seasons/${seasonId}?err=season-not-found`);

  const plans = await planSeasonSubGroups(seasonId, season!.subGroupSize, { apply: true });

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.generate-subgroups",
    targetType: "Season",
    targetId: seasonId,
    summary: `Generated sub-groups for ${plans.length} division(s) (target size ${season!.subGroupSize})`,
    metadata: {
      seasonId,
      groupSize: season!.subGroupSize,
      divisions: plans.map((p) => ({ name: p.divisionName, members: p.memberCount, groups: p.groupCount })),
    },
  });

  revalidatePath(`/seasons/${seasonId}`);
  redirect(`/seasons/${seasonId}?ok=1`);
}

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
