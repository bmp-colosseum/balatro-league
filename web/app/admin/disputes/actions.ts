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

// Carry a resolved dispute's per-game detail onto the Game rows WITHOUT wiping
// deck/stake: each game's winner is updated from the corrected score, and its
// winnerLives only when a value was given — everything else (deck, stake) is
// preserved. Creates rows only if none exist AND lives were given. Game 1/2
// winners: 2-0 → A both, 0-2 → B both, 1-1 → A then B.
async function applyResolvedGames(
  pairing: { id: string; playerAId: string; playerBId: string },
  gamesWonA: number,
  gamesWonB: number,
  livesG1: number | null,
  livesG2: number | null,
): Promise<void> {
  const existing = await prisma.game.count({ where: { matchId: pairing.id } });
  const hasLives = livesG1 != null || livesG2 != null;
  if (existing === 0 && !hasLives) return; // nothing to carry, nothing to fix
  const [w1, w2] =
    gamesWonA > gamesWonB ? [pairing.playerAId, pairing.playerAId]
      : gamesWonB > gamesWonA ? [pairing.playerBId, pairing.playerBId]
      : [pairing.playerAId, pairing.playerBId];
  const upsert = (num: number, winnerId: string, lives: number | null) =>
    prisma.game.upsert({
      where: { matchId_num: { matchId: pairing.id, num } },
      // Preserve deck/stake — only set the winner, and lives when provided.
      update: { winnerId, ...(lives != null ? { winnerLives: lives } : {}) },
      create: { matchId: pairing.id, num, firstPlayerId: pairing.playerAId, winnerId, winnerLives: lives },
    });
  await upsert(1, w1, livesG1);
  await upsert(2, w2, livesG2);
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

  // Carry the disputer's per-game lives onto the Game rows (keeping any deck/stake
  // already recorded).
  await applyResolvedGames(pairing, acceptedA!, acceptedB!, pairing.disputeProposedLivesG1, pairing.disputeProposedLivesG2);
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

  // Optional per-game winner's lives the helper can enter with the corrected
  // result (same fidelity as a normal record).
  const parseLives = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
  };
  const livesG1 = parseLives("livesGame1");
  const livesG2 = parseLives("livesGame2");

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

  // Carry the helper's per-game lives onto the Game rows (keeping any deck/stake).
  await applyResolvedGames(pairing, games![0], games![1], livesG1, livesG2);
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
