// Shared report/confirm/dispute logic. Used by both the Discord /report flow and the web /me/report page
// so the same validation runs no matter how the set is submitted.

import { activePublicSeason } from "./active-season.js";
import { announceResult } from "./announce.js";
import { prisma } from "./db.js";
import { gamesFromResult, type PairingResult } from "./scoring.js";

export interface ReportInput {
  reporterPlayerId: string;
  opponentPlayerId: string;
  result: PairingResult;
}

export type ReportResult =
  | { ok: true; pairingId: string; status: "CREATED" | "REREPORTED" }
  | { ok: false; reason: string };

export async function reportSet(input: ReportInput): Promise<ReportResult> {
  if (input.reporterPlayerId === input.opponentPlayerId) {
    return { ok: false, reason: "You can't report a set against yourself." };
  }

  const activeSeason = await activePublicSeason();
  if (!activeSeason) return { ok: false, reason: "No active season right now." };

  const sharedMembership = await prisma.divisionMember.findFirst({
    where: {
      playerId: input.reporterPlayerId,
      division: { seasonId: activeSeason.id },
    },
    include: {
      division: {
        include: { members: { where: { playerId: input.opponentPlayerId } } },
      },
    },
  });

  if (!sharedMembership || sharedMembership.division.members.length === 0) {
    return { ok: false, reason: "You and your opponent aren't in the same division this season." };
  }

  const division = sharedMembership.division;
  const [playerAId, playerBId] =
    input.reporterPlayerId < input.opponentPlayerId
      ? [input.reporterPlayerId, input.opponentPlayerId]
      : [input.opponentPlayerId, input.reporterPlayerId];
  const reporterIsA = input.reporterPlayerId === playerAId;
  const games = gamesFromResult(input.result);
  const gamesWonA = reporterIsA ? games.a : games.b;
  const gamesWonB = reporterIsA ? games.b : games.a;

  const existing = await prisma.pairing.findUnique({
    where: { divisionId_playerAId_playerBId: { divisionId: division.id, playerAId, playerBId } },
  });

  if (existing && existing.status === "CONFIRMED") {
    return {
      ok: false,
      reason: `This set is already confirmed (${existing.gamesWonA}-${existing.gamesWonB}). Ask an admin if it needs to change.`,
    };
  }
  if (existing && existing.status === "PENDING") {
    return {
      ok: false,
      reason: "There's already a pending report for this set. The opponent needs to confirm or dispute it first.",
    };
  }

  const pairing = existing
    ? await prisma.pairing.update({
        where: { id: existing.id },
        data: {
          gamesWonA,
          gamesWonB,
          status: "PENDING",
          reporterId: input.reporterPlayerId,
          reportedAt: new Date(),
          confirmedAt: null,
        },
      })
    : await prisma.pairing.create({
        data: {
          divisionId: division.id,
          playerAId,
          playerBId,
          gamesWonA,
          gamesWonB,
          status: "PENDING",
          reporterId: input.reporterPlayerId,
          reportedAt: new Date(),
        },
      });

  return { ok: true, pairingId: pairing.id, status: existing ? "REREPORTED" : "CREATED" };
}

export type ResolveResult =
  | { ok: true }
  | { ok: false; reason: string };

// confirmSet / disputeSet: actor must be the OPPONENT (not the reporter)
export async function confirmSet(pairingId: string, actorPlayerId: string): Promise<ResolveResult> {
  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true },
  });
  if (!pairing) return { ok: false, reason: "Set not found." };
  if (pairing.status !== "PENDING") {
    return { ok: false, reason: `This set is ${pairing.status.toLowerCase()} — nothing to confirm.` };
  }
  if (pairing.reporterId === actorPlayerId) {
    return { ok: false, reason: "Only the opponent can confirm a set." };
  }
  if (pairing.playerAId !== actorPlayerId && pairing.playerBId !== actorPlayerId) {
    return { ok: false, reason: "You're not part of this set." };
  }
  await prisma.pairing.update({
    where: { id: pairingId },
    data: { status: "CONFIRMED", confirmedAt: new Date() },
  });
  // Fire-and-forget — don't block the caller on Discord network round-trip
  announceResult(pairingId).catch(() => {});
  return { ok: true };
}

export async function disputeSet(pairingId: string, actorPlayerId: string): Promise<ResolveResult> {
  const pairing = await prisma.pairing.findUnique({ where: { id: pairingId } });
  if (!pairing) return { ok: false, reason: "Set not found." };
  if (pairing.status !== "PENDING") {
    return { ok: false, reason: `This set is ${pairing.status.toLowerCase()} — nothing to dispute.` };
  }
  if (pairing.reporterId === actorPlayerId) {
    return { ok: false, reason: "Only the opponent can dispute a set." };
  }
  if (pairing.playerAId !== actorPlayerId && pairing.playerBId !== actorPlayerId) {
    return { ok: false, reason: "You're not part of this set." };
  }
  await prisma.pairing.update({
    where: { id: pairingId },
    data: { status: "DISPUTED" },
  });
  return { ok: true };
}
