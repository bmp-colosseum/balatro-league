"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { enqueueAnnounceResult } from "@/lib/queue";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { deleteChannel } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import { recomputeDivisionStandings } from "@/lib/standings-cache";

// Close the Discord dispute thread once the dispute is resolved on the
// web — keeps the two surfaces in sync (resolving here also tidies Discord).
async function closeDisputeThread(disputeThreadId: string | null): Promise<void> {
  if (disputeThreadId) await deleteChannel(disputeThreadId).catch(() => {});
}

// Accept the disputer's proposed correction wholesale. One-click path
// when the helper agrees with what the disputer says it should have
// been. Writes the proposed games as the new result, flips to
// CONFIRMED, stamps admin override fields for audit.
export async function acceptDisputeProposal(formData: FormData) {
  const { user } = await requireAdmin();
  const pairingId = String(formData.get("pairingId") ?? "").trim();
  if (!pairingId) redirect("/admin/disputes?err=missing-id");

  const pairing = await prisma.pairing.findUnique({ where: { id: pairingId } });
  if (!pairing) redirect("/admin/disputes?err=not-found");
  if (pairing.status !== "DISPUTED") {
    redirect(`/admin/disputes?err=${encodeURIComponent("Match isn't disputed")}`);
  }
  if (
    pairing.disputeProposedGamesWonA == null ||
    pairing.disputeProposedGamesWonB == null
  ) {
    redirect(`/admin/disputes?err=${encodeURIComponent("No proposed result to accept — use Custom Edit instead")}`);
  }

  await prisma.pairing.update({
    where: { id: pairingId },
    data: {
      gamesWonA: pairing.disputeProposedGamesWonA,
      gamesWonB: pairing.disputeProposedGamesWonB,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: user.discordId,
      adminOverrideReason: pairing.disputeReason
        ? `Accepted disputer's proposal: ${pairing.disputeReason}`
        : "Accepted disputer's proposal",
      disputeProposedGamesWonA: null,
      disputeProposedGamesWonB: null,
    },
  });
  await closeDisputeThread(pairing.disputeThreadId);
  // Re-announce the corrected result so the channel sees the final
  // numbers — admin's accept-the-proposal flow effectively re-posts
  // the match with the new scores.
  enqueueAnnounceResult(pairingId).catch((err) => console.warn("[dispute.accept] announceResult failed:", err));
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "dispute.accept-proposal",
    targetType: "Pairing",
    targetId: pairingId,
    summary: `Accepted disputer's proposal: ${pairing.gamesWonA}-${pairing.gamesWonB} → ${pairing.disputeProposedGamesWonA}-${pairing.disputeProposedGamesWonB}`,
    metadata: {
      previous: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
      next: { gamesWonA: pairing.disputeProposedGamesWonA, gamesWonB: pairing.disputeProposedGamesWonB },
      disputeReason: pairing.disputeReason,
      disputedById: pairing.disputedById,
    },
  });
  revalidatePath("/admin/disputes");
  revalidatePath("/standings");
  redirect("/admin/disputes?ok=accepted");
}

// Reject the dispute — keep the original result, flip back to CONFIRMED
// with admin attribution. Used when the helper sides with the original
// report.
export async function rejectDispute(formData: FormData) {
  const { user } = await requireAdmin();
  const pairingId = String(formData.get("pairingId") ?? "").trim();
  if (!pairingId) redirect("/admin/disputes?err=missing-id");

  const pairing = await prisma.pairing.findUnique({ where: { id: pairingId } });
  if (!pairing) redirect("/admin/disputes?err=not-found");
  if (pairing.status !== "DISPUTED") {
    redirect(`/admin/disputes?err=${encodeURIComponent("Match isn't disputed")}`);
  }

  await prisma.pairing.update({
    where: { id: pairingId },
    data: {
      status: "CONFIRMED",
      confirmedAt: pairing.confirmedAt ?? new Date(),
      adminOverrideBy: user.discordId,
      adminOverrideReason: "Dispute rejected, original result kept",
      disputeProposedGamesWonA: null,
      disputeProposedGamesWonB: null,
    },
  });
  await closeDisputeThread(pairing.disputeThreadId);
  // Re-announce so the channel knows the dispute was rejected and
  // the original result stands.
  enqueueAnnounceResult(pairingId).catch((err) => console.warn("[dispute.reject] announceResult failed:", err));
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "dispute.reject",
    targetType: "Pairing",
    targetId: pairingId,
    summary: `Rejected dispute, kept ${pairing.gamesWonA}-${pairing.gamesWonB}`,
    metadata: {
      result: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
      disputeReason: pairing.disputeReason,
      disputedById: pairing.disputedById,
    },
  });
  revalidatePath("/admin/disputes");
  revalidatePath("/standings");
  redirect("/admin/disputes?ok=rejected");
}
