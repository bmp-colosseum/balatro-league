"use server";

// Index-level signup-round actions.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

// Delete a signup round (its Signups cascade away). For cleaning up old or
// abandoned rounds — the index used to accumulate every round ever opened with
// no way to retire one. Safe even for a BUILT round: the round only *points at*
// its resulting Season (resultingSeasonId lives on the round, not vice-versa),
// so deleting it leaves the season and its standings untouched — it just removes
// the historical signup record.
export async function deleteSignupRound(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;
  await prisma.signupRound.delete({ where: { id: roundId } });
  revalidatePath("/admin/signups");
}
