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

  const pairing = await prisma.match.findUnique({ where: { id: pairingId } });
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

  const acceptedA = pairing.disputeProposedGamesWonA;
  const acceptedB = pairing.disputeProposedGamesWonB;
  await prisma.match.update({
    where: { id: pairingId },
    data: {
      gamesWonA: acceptedA,
      gamesWonB: acceptedB,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: user.discordId,
      adminOverrideReason: pairing.disputeReason
        ? `Accepted disputer's proposal: ${pairing.disputeReason}`
        : "Accepted disputer's proposal",
      disputeProposedGamesWonA: null,
      disputeProposedGamesWonB: null,
      disputeProposedLivesG1: null,
      disputeProposedLivesG2: null,
    },
  });

  // Carry the disputer's per-game lives onto real Game rows (same fidelity as a
  // normal report) when they gave them. Each game's winner comes from the
  // accepted score: 2-0 → A both, 0-2 → B both, 1-1 → A then B.
  const g1 = pairing.disputeProposedLivesG1;
  const g2 = pairing.disputeProposedLivesG2;
  if (g1 != null || g2 != null) {
    const [w1, w2] =
      acceptedA! > acceptedB! ? [pairing.playerAId, pairing.playerAId]
        : acceptedB! > acceptedA! ? [pairing.playerBId, pairing.playerBId]
        : [pairing.playerAId, pairing.playerBId];
    await prisma.game.deleteMany({ where: { matchId: pairingId } });
    await prisma.game.createMany({
      data: [
        { matchId: pairingId, num: 1, firstPlayerId: pairing.playerAId, winnerId: w1, winnerLives: g1 },
        { matchId: pairingId, num: 2, firstPlayerId: pairing.playerAId, winnerId: w2, winnerLives: g2 },
      ],
    });
  }
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

  const pairing = await prisma.match.findUnique({ where: { id: pairingId } });
  if (!pairing) redirect("/admin/disputes?err=not-found");
  if (pairing.status !== "DISPUTED") {
    redirect(`/admin/disputes?err=${encodeURIComponent("Match isn't disputed")}`);
  }

  await prisma.match.update({
    where: { id: pairingId },
    data: {
      status: "CONFIRMED",
      confirmedAt: pairing.confirmedAt ?? new Date(),
      adminOverrideBy: user.discordId,
      adminOverrideReason: "Dispute rejected, original result kept",
      disputeProposedGamesWonA: null,
      disputeProposedGamesWonB: null,
      disputeProposedLivesG1: null,
      disputeProposedLivesG2: null,
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

// Set a DIFFERENT result than either the reported or proposed score, in
// one click. For when neither side had it right.
export async function setDisputeResult(formData: FormData) {
  const { user } = await requireAdmin();
  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const resultStr = String(formData.get("result") ?? "");
  if (!pairingId) redirect("/admin/disputes?err=missing-id");
  const map: Record<string, [number, number]> = { "2-0": [2, 0], "1-1": [1, 1], "0-2": [0, 2] };
  const games = map[resultStr];
  if (!games) redirect(`/admin/disputes?err=${encodeURIComponent("Pick a result")}`);

  const pairing = await prisma.match.findUnique({ where: { id: pairingId } });
  if (!pairing) redirect("/admin/disputes?err=not-found");
  if (pairing.status !== "DISPUTED") {
    redirect(`/admin/disputes?err=${encodeURIComponent("Match isn't disputed")}`);
  }

  await prisma.match.update({
    where: { id: pairingId },
    data: {
      status: "CONFIRMED",
      gamesWonA: games![0],
      gamesWonB: games![1],
      confirmedAt: new Date(),
      adminOverrideBy: user.discordId,
      adminOverrideReason: "Dispute resolved — admin set a corrected result",
      disputeProposedGamesWonA: null,
      disputeProposedGamesWonB: null,
      disputeProposedLivesG1: null,
      disputeProposedLivesG2: null,
    },
  });
  await closeDisputeThread(pairing.disputeThreadId);
  enqueueAnnounceResult(pairingId).catch((err) => console.warn("[dispute.custom] announceResult failed:", err));
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "dispute.resolve-custom",
    targetType: "Pairing",
    targetId: pairingId,
    summary: `Set corrected result ${games![0]}-${games![1]} (was ${pairing.gamesWonA}-${pairing.gamesWonB})`,
    metadata: {
      previous: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
      next: { gamesWonA: games![0], gamesWonB: games![1] },
      disputeReason: pairing.disputeReason,
    },
  });
  revalidatePath("/admin/disputes");
  revalidatePath("/standings");
  redirect("/admin/disputes?ok=custom");
}
