"use server";

// Server actions for the merged /admin/matches page -- moved verbatim (same
// mutations, same validation, same audit trail) from the three pages it
// replaces: admin/results/actions.ts (record/override/forfeit/showdown/undo),
// admin/resolve/actions.ts (bulk apply), and admin/disputes/actions.ts
// (accept proposed / reject / set a custom result). Every action now accepts
// an optional `returnTo` so it lands back on the admin's filtered view
// instead of always bouncing to a fixed path -- the old pages each had only
// one URL to go back to; this one has a filter bar.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { enqueueAnnounceResult } from "@/lib/queue";
import { deleteChannel } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import {
  recordResult,
  overrideResult,
  forfeitResult,
  recordShowdown,
  undoResult,
  type ResultStr,
} from "@/lib/match-admin";
import { applyBulkResolve, type BulkAction } from "@/lib/bulk-resolve";

const PAGE = "/admin/matches";
const RESULTS = ["2-0", "1-1", "0-2"];

function returnPath(formData: FormData): string {
  const raw = String(formData.get("returnTo") ?? "").trim();
  return raw.startsWith(PAGE) || raw.startsWith("/admin/matches") ? raw : PAGE;
}

function back(returnTo: string, msg: string): never {
  revalidatePath(PAGE);
  const sep = returnTo.includes("?") ? "&" : "?";
  redirect(`${returnTo}${sep}ok=${encodeURIComponent(msg)}`);
}

// ---- Single-match record / override / forfeit / showdown / undo (moved
// from admin/results/actions.ts) -------------------------------------------

export async function recordResultAction(formData: FormData) {
  const { user } = await requireAdmin();
  const returnTo = returnPath(formData);
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerAId = String(formData.get("playerAId") ?? "");
  const playerBId = String(formData.get("playerBId") ?? "");
  const result = String(formData.get("result") ?? "") as ResultStr;
  if (divisionId && playerAId && playerBId && RESULTS.includes(result)) {
    await recordResult({ divisionId, playerAId, playerBId, result, actor: actorFromAdminUser(user) });
  }
  back(returnTo, "recorded");
}

export async function overrideResultAction(formData: FormData) {
  const { user } = await requireAdmin();
  const returnTo = returnPath(formData);
  const matchId = String(formData.get("matchId") ?? "");
  const result = String(formData.get("result") ?? "") as ResultStr;
  if (matchId && RESULTS.includes(result)) {
    await overrideResult({ matchId, result, actor: actorFromAdminUser(user) });
  }
  back(returnTo, "overridden");
}

export async function forfeitAction(formData: FormData) {
  const { user } = await requireAdmin();
  const returnTo = returnPath(formData);
  const divisionId = String(formData.get("divisionId") ?? "");
  const winnerId = String(formData.get("winnerId") ?? "");
  const loserId = String(formData.get("loserId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (divisionId && winnerId && loserId && reason) {
    await forfeitResult({ divisionId, winnerId, loserId, reason, actor: actorFromAdminUser(user) });
  }
  back(returnTo, "forfeit");
}

export async function showdownAction(formData: FormData) {
  const { user } = await requireAdmin();
  const returnTo = returnPath(formData);
  const divisionId = String(formData.get("divisionId") ?? "");
  const p1Id = String(formData.get("p1Id") ?? "");
  const p2Id = String(formData.get("p2Id") ?? "");
  const winnerId = String(formData.get("winnerId") ?? "");
  if (divisionId && p1Id && p2Id && winnerId) {
    await recordShowdown({ divisionId, p1Id, p2Id, winnerId, actor: actorFromAdminUser(user) });
  }
  back(returnTo, "showdown");
}

export async function undoAction(formData: FormData) {
  const { user } = await requireAdmin();
  const returnTo = returnPath(formData);
  const matchId = String(formData.get("matchId") ?? "");
  if (matchId) {
    await undoResult({ matchId, actor: actorFromAdminUser(user) });
  }
  back(returnTo, "undone");
}

// ---- Bulk apply (moved from admin/resolve/actions.ts, unchanged) ----------

function isBulkAction(value: string): value is BulkAction {
  return value === "void" || value === "forfeit-a" || value === "forfeit-b" || value === "double-forfeit";
}

function summarizeBulk(appliedCount: number, refused: Array<{ id: string; reason: string }>): string {
  const parts = [`Applied to ${appliedCount} match${appliedCount === 1 ? "" : "es"}.`];
  if (refused.length > 0) {
    const sample = [...new Set(refused.map((r) => r.reason))].slice(0, 3);
    const extra = refused.length > sample.length ? ` (and ${refused.length - sample.length} more)` : "";
    parts.push(`${refused.length} refused -- ${sample.join("; ")}${extra}`);
  }
  return parts.join(" ");
}

export async function applyBulkResolveAction(formData: FormData) {
  const { user } = await requireAdmin();
  const ids = [...new Set(formData.getAll("ids").map((v) => String(v).trim()).filter(Boolean))];
  const actionRaw = String(formData.get("action") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const returnTo = returnPath(formData);

  if (ids.length === 0 || !isBulkAction(actionRaw)) {
    redirect(`${PAGE}?err=${encodeURIComponent("Select at least one match and an action before applying.")}`);
  }

  const result = await applyBulkResolve({ ids, action: actionRaw, reason, actor: actorFromAdminUser(user) });

  revalidatePath(PAGE);
  const sep = returnTo.includes("?") ? "&" : "?";
  const param = result.applied.length === 0 ? "err" : "ok";
  const msg = summarizeBulk(result.applied.length, result.refused);
  redirect(`${returnTo}${sep}${param}=${encodeURIComponent(msg)}`);
}

// ---- Dispute accept / reject / custom result (moved from
// admin/disputes/actions.ts, unchanged behaviour) ---------------------------

async function closeDisputeThread(disputeThreadId: string | null): Promise<void> {
  if (disputeThreadId) await deleteChannel(disputeThreadId).catch(() => {});
}

// Carry a resolved dispute's per-game detail onto the Game rows WITHOUT wiping
// deck/stake: each game's winner is updated from the corrected score, and its
// winnerLives only when a value was given -- everything else (deck, stake) is
// preserved. Creates rows only if none exist AND lives were given. Game 1/2
// winners: 2-0 -> A both, 0-2 -> B both, 1-1 -> A then B.
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
      update: { winnerId, ...(lives != null ? { winnerLives: lives } : {}) },
      create: { matchId: pairing.id, num, firstPlayerId: pairing.playerAId, winnerId, winnerLives: lives },
    });
  await upsert(1, w1, livesG1);
  await upsert(2, w2, livesG2);
}

export async function acceptDisputeProposal(formData: FormData) {
  const { user } = await requireAdmin();
  const returnTo = returnPath(formData);
  const pairingId = String(formData.get("pairingId") ?? "").trim();
  if (!pairingId) redirect(`${PAGE}?err=missing-id`);

  const pairing = await prisma.match.findUnique({ where: { id: pairingId } });
  if (!pairing) redirect(`${PAGE}?err=not-found`);
  if (pairing.status !== "DISPUTED") {
    redirect(`${PAGE}?err=${encodeURIComponent("Match isn't disputed")}`);
  }
  if (pairing.disputeProposedGamesWonA == null || pairing.disputeProposedGamesWonB == null) {
    redirect(`${PAGE}?err=${encodeURIComponent("No proposed result to accept -- use Custom Edit instead")}`);
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

  await applyResolvedGames(pairing, acceptedA!, acceptedB!, pairing.disputeProposedLivesG1, pairing.disputeProposedLivesG2);
  await closeDisputeThread(pairing.disputeThreadId);
  enqueueAnnounceResult(pairingId).catch((err) => console.warn("[dispute.accept] announceResult failed:", err));
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "dispute.accept-proposal",
    targetType: "Pairing",
    targetId: pairingId,
    summary: `Accepted disputer's proposal: ${pairing.gamesWonA}-${pairing.gamesWonB} -> ${pairing.disputeProposedGamesWonA}-${pairing.disputeProposedGamesWonB}`,
    metadata: {
      previous: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
      next: { gamesWonA: pairing.disputeProposedGamesWonA, gamesWonB: pairing.disputeProposedGamesWonB },
      disputeReason: pairing.disputeReason,
      disputedById: pairing.disputedById,
    },
  });
  revalidatePath(PAGE);
  revalidatePath("/standings");
  back(returnTo, "accepted");
}

export async function rejectDispute(formData: FormData) {
  const { user } = await requireAdmin();
  const returnTo = returnPath(formData);
  const pairingId = String(formData.get("pairingId") ?? "").trim();
  if (!pairingId) redirect(`${PAGE}?err=missing-id`);

  const pairing = await prisma.match.findUnique({ where: { id: pairingId } });
  if (!pairing) redirect(`${PAGE}?err=not-found`);
  if (pairing.status !== "DISPUTED") {
    redirect(`${PAGE}?err=${encodeURIComponent("Match isn't disputed")}`);
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
  revalidatePath(PAGE);
  revalidatePath("/standings");
  back(returnTo, "rejected");
}

export async function setDisputeResult(formData: FormData) {
  const { user } = await requireAdmin();
  const returnTo = returnPath(formData);
  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const resultStr = String(formData.get("result") ?? "");
  if (!pairingId) redirect(`${PAGE}?err=missing-id`);
  const map: Record<string, [number, number]> = { "2-0": [2, 0], "1-1": [1, 1], "0-2": [0, 2] };
  const games = map[resultStr];
  if (!games) redirect(`${PAGE}?err=${encodeURIComponent("Pick a result")}`);

  const parseLives = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
  };
  const livesG1 = parseLives("livesGame1");
  const livesG2 = parseLives("livesGame2");

  const pairing = await prisma.match.findUnique({ where: { id: pairingId } });
  if (!pairing) redirect(`${PAGE}?err=not-found`);
  if (pairing.status !== "DISPUTED") {
    redirect(`${PAGE}?err=${encodeURIComponent("Match isn't disputed")}`);
  }

  await prisma.match.update({
    where: { id: pairingId },
    data: {
      status: "CONFIRMED",
      gamesWonA: games![0],
      gamesWonB: games![1],
      confirmedAt: new Date(),
      adminOverrideBy: user.discordId,
      adminOverrideReason: "Dispute resolved -- admin set a corrected result",
      disputeProposedGamesWonA: null,
      disputeProposedGamesWonB: null,
      disputeProposedLivesG1: null,
      disputeProposedLivesG2: null,
    },
  });

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
  revalidatePath(PAGE);
  revalidatePath("/standings");
  back(returnTo, "custom");
}
