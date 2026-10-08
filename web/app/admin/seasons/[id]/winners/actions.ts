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
import { recordAudit, actorFromAdminUser } from "@/lib/audit";
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

// Record the champion of a division whose standings still show a tie for #1 --
// for ended seasons where the tie was settled outside the system (or never
// recorded) and the shootout tool no longer applies. The pick MUST be one of the
// currently tied players; a clear winner uses setDivisionAwarded instead. Pure
// bookkeeping: writes championPlayerId only, never touches Discord roles. The
// role audit (/admin/roles) and the Nx <Tier> Winner counts read this field, so
// every unresolved old tie silently costs its winner a title until it is set.
export async function setDivisionChampionManual(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const winnerPlayerId = String(formData.get("winnerPlayerId") ?? "");
  if (!divisionId || !winnerPlayerId) return { ok: false, message: "Pick a player first." };

  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { id: true, name: true, seasonId: true, season: { select: { number: true, subtitle: true } } },
  });
  if (!division) return { ok: false, message: "Division not found." };

  const standings = (await loadManyDivisionStandings([divisionId])).get(divisionId) ?? [];
  const tied = pickDivisionWinners(standings);
  if (tied.length < 2) {
    return { ok: false, message: `${division.name}: no tie for #1 -- use Mark awarded.` };
  }
  const winner = tied.find((r) => r.player.id === winnerPlayerId);
  if (!winner) return { ok: false, message: `${division.name}: that player is not among the tied leaders.` };

  await prisma.division.update({ where: { id: divisionId }, data: { championPlayerId: winner.player.id } });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "division.set-champion",
    targetType: "Division",
    targetId: divisionId,
    summary: `Set ${division.name} champion to ${winner.player.displayName} (tie for #1 among ${tied.length}, settled by hand)`,
    metadata: { divisionId, seasonId: division.seasonId, winnerPlayerId: winner.player.id, tiedPlayerIds: tied.map((r) => r.player.id) },
  });
  revalidatePath(`/admin/seasons/${division.seasonId}/winners`);
  return { ok: true, message: `${division.name}: champion set to ${winner.player.displayName}.` };
}
