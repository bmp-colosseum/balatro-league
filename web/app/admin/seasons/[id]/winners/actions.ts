"use server";

// Manual award tracking for /admin/seasons/[id]/winners. Sets or clears
// Division.championPlayerId WITHOUT touching Discord roles -- for TOs who hand
// out awards their own way and just want to check them off as done. The
// role-assigning flow is awardSeasonChampionRoles (bootstrap-actions.ts); this
// is the bookkeeping-only counterpart, writing the SAME field so the winners
// page status column and the role flow stay consistent.
//
// The winner is re-derived from live standings here, never trusted from a
// hidden form field -- so a stale row can't mark the wrong player awarded.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { loadManyDivisionStandings } from "@/lib/standings-cache";
import { pickDivisionWinners } from "@/lib/loaders/admin-winners";
import type { ActionResult } from "@/lib/action-result";

export async function setDivisionAwarded(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const awarded = String(formData.get("awarded") ?? "") === "1";
  if (!divisionId) return { ok: false, message: "Missing division." };

  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { id: true, name: true, seasonId: true },
  });
  if (!division) return { ok: false, message: "Division not found." };

  if (!awarded) {
    await prisma.division.update({
      where: { id: divisionId },
      data: { championPlayerId: null },
    });
    revalidatePath(`/admin/seasons/${division.seasonId}/winners`);
    return { ok: true, message: `${division.name}: marked pending.` };
  }

  // Re-derive the current winner from live standings rather than trust the row
  // the admin clicked -- standings may have moved since the page rendered.
  const standings =
    (await loadManyDivisionStandings([divisionId])).get(divisionId) ?? [];
  const hasPlayed = standings.some((r) => r.played > 0);
  if (!hasPlayed) return { ok: false, message: `${division.name}: no matches played yet.` };
  const winners = pickDivisionWinners(standings);
  if (winners.length === 0) return { ok: false, message: `${division.name}: no clear winner.` };
  if (winners.length > 1) {
    return { ok: false, message: `${division.name}: still a tie for #1 -- resolve it first.` };
  }

  const winner = winners[0]!;
  await prisma.division.update({
    where: { id: divisionId },
    data: { championPlayerId: winner.player.id },
  });
  revalidatePath(`/admin/seasons/${division.seasonId}/winners`);
  return {
    ok: true,
    message: `${division.name}: marked awarded to ${winner.player.displayName}.`,
  };
}
