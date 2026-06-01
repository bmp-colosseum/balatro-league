"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { recomputeDivisionStandings } from "@/lib/standings-cache";

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
      adminOverrideBy: (user as { discordId?: string } | undefined)?.discordId ?? "web-dashboard",
      adminOverrideReason: pairing.disputeReason
        ? `Accepted disputer's proposal: ${pairing.disputeReason}`
        : "Accepted disputer's proposal",
    },
  });
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
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
      adminOverrideBy: (user as { discordId?: string } | undefined)?.discordId ?? "web-dashboard",
      adminOverrideReason: "Dispute rejected, original result kept",
    },
  });
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  revalidatePath("/admin/disputes");
  revalidatePath("/standings");
  redirect("/admin/disputes?ok=rejected");
}
