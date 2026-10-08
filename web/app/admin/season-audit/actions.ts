"use server";

// Server actions for /admin/season-audit:
//   - markReviewedAction / unmarkReviewedAction: dismiss (or restore) one
//     finding that can never be fixed, keyed by (seasonId, code, key) --
//     `key` is the finding's own deterministic identity from
//     season-audit-core.ts, so a review stays attached to THIS finding and
//     drops on its own once the underlying condition is actually fixed.
//   - recomputeFinalRanksAction: for an ENDED season whose stored
//     DivisionMember.finalGlobalRank values were written by an older
//     ranking algorithm, rewrite ONLY finalGlobalRank from today's cached
//     standings -- Player.rating (owned by whichever season last ended)
//     is never touched here.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { loadDivisionStandings } from "@/lib/standings-cache";
import { computeRatingDeltas, type DivisionForRating } from "@/lib/end-season";

const PAGE_PATH = "/admin/season-audit";

function backTo(seasonId: string, query: string): never {
  redirect(`${PAGE_PATH}?season=${encodeURIComponent(seasonId)}&${query}`);
}

export async function markReviewedAction(formData: FormData): Promise<void> {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const key = String(formData.get("key") ?? "").trim();
  const divisionId = String(formData.get("divisionId") ?? "").trim() || null;
  const noteRaw = String(formData.get("note") ?? "").trim();
  const note = noteRaw.length > 0 ? noteRaw : null;

  if (!seasonId || !code || !key) {
    redirect(`${PAGE_PATH}?err=missing-fields`);
  }

  const actor = actorFromAdminUser(user);
  await prisma.seasonAuditReview.upsert({
    where: { seasonId_code_key: { seasonId, code, key } },
    create: { seasonId, divisionId, code, key, note, reviewedBy: actor.displayName },
    update: { note, reviewedBy: actor.displayName },
  });

  recordAudit({
    actor,
    action: "season-audit.review",
    targetType: "Season",
    targetId: seasonId,
    summary: `Marked season-audit finding reviewed (${code})`,
    metadata: { seasonId, code, key, note },
  });

  revalidatePath(PAGE_PATH);
  backTo(seasonId, "ok=reviewed");
}

export async function unmarkReviewedAction(formData: FormData): Promise<void> {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const key = String(formData.get("key") ?? "").trim();

  if (!seasonId || !code || !key) {
    redirect(`${PAGE_PATH}?err=missing-fields`);
  }

  await prisma.seasonAuditReview.deleteMany({ where: { seasonId, code, key } });

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season-audit.unreview",
    targetType: "Season",
    targetId: seasonId,
    summary: `Unmarked season-audit finding reviewed (${code})`,
    metadata: { seasonId, code, key },
  });

  revalidatePath(PAGE_PATH);
  backTo(seasonId, "ok=unreviewed");
}

// Recompute every ACTIVE member's finalGlobalRank from TODAY's cached
// standings, using the SAME placement math endSeasonCore uses
// (computeRatingDeltas over one DivisionForRating per division) -- just
// without touching Player.rating, which belongs to whichever season last
// ended. Refuses on a season that hasn't ended: an active season's ranks
// aren't "final" yet by definition.
export async function recomputeFinalRanksAction(formData: FormData): Promise<void> {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "").trim();
  if (!seasonId) {
    redirect(`${PAGE_PATH}?err=missing-fields`);
  }

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: {
      tiers: { orderBy: { position: "asc" } },
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: { tier: true, members: { include: { player: true } } },
      },
    },
  });
  if (!season) {
    redirect(`${PAGE_PATH}?err=season-not-found`);
  }
  if (!season.endedAt) {
    backTo(seasonId, "err=not-ended");
  }

  const divisionsForRating: DivisionForRating[] = [];
  for (const d of season.divisions) {
    divisionsForRating.push({
      tierPosition: d.tier.position,
      divisionGroupNumber: d.groupNumber,
      promoteCount: d.promoteCount,
      relegateCount: d.relegateCount,
      members: d.members.map((m) => ({
        playerId: m.playerId,
        status: m.status,
        currentRating: m.player.rating,
      })),
      standings: await loadDivisionStandings(d.id),
    });
  }

  const deltas = computeRatingDeltas(season.tiers.length, divisionsForRating);

  const results = await prisma.$transaction(
    deltas.map((d) =>
      prisma.divisionMember.updateMany({
        where: { seasonId, playerId: d.playerId, status: "ACTIVE" },
        data: { finalGlobalRank: d.finalRank },
      }),
    ),
  );
  const updated = results.reduce((sum, r) => sum + r.count, 0);

  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.recompute-final-ranks",
    targetType: "Season",
    targetId: seasonId,
    summary: `Recomputed final ranks from current standings for ${updated} member(s)`,
    metadata: { seasonId, updated },
  });

  revalidatePath(PAGE_PATH);
  backTo(seasonId, `ok=ranks-${updated}`);
}
