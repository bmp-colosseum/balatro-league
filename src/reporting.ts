// Shared report/confirm/dispute logic. Used by both the Discord /report flow and the web /me/report page
// so the same validation runs no matter how the set is submitted.

import { activePublicSeason } from "./active-season.js";
import { prisma } from "./db.js";
import { enqueueAnnounceResult } from "./queue.js";
import { gamesFromResult, type PairingResult } from "./scoring.js";
import { recomputeDivisionStandings } from "./standings-cache.js";

export interface ReportInput {
  reporterPlayerId: string;
  opponentPlayerId: string;
  result: PairingResult;
  // Optional combo that was played — captured for the record / history.
  deck?: string | null;
  stake?: string | null;
}

export type ReportResult =
  | { ok: true; pairingId: string; status: "CREATED" | "REREPORTED" }
  | { ok: false; reason: string };

export async function reportSet(input: ReportInput): Promise<ReportResult> {
  if (input.reporterPlayerId === input.opponentPlayerId) {
    return { ok: false, reason: "You can't report a match against yourself." };
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

  const existing = await prisma.match.findUnique({
    where: {
      divisionId_playerAId_playerBId_format: {
        divisionId: division.id,
        playerAId,
        playerBId,
        format: "LEAGUE_BO2",
      },
    },
  });

  if (existing && existing.status === "CONFIRMED") {
    return {
      ok: false,
      reason: `This match is already recorded (${existing.gamesWonA}-${existing.gamesWonB}). Ask an admin if it needs to change.`,
    };
  }
  // A pre-created (locked-schedule) match is PENDING with no reporter yet — that's
  // an UNPLAYED assigned matchup, not a pending report, so let the report below
  // fill it in. A PENDING row WITH a reporter is a real report awaiting confirm.
  if (existing && existing.status === "PENDING" && existing.reporterId) {
    return {
      ok: false,
      reason: "There's already a pending report for this match. The opponent needs to confirm or dispute it first.",
    };
  }

  // Schedule enforcement: when the division runs a locked schedule, the only valid
  // matchups are the pre-created ones. No row for this pair means it isn't on the
  // schedule — reject. With no locked schedule (legacy on-demand round-robin) any
  // same-division pair is allowed.
  if (!existing) {
    const lockedSchedule = await prisma.match.findFirst({
      where: { divisionId: division.id, format: "LEAGUE_BO2", status: "PENDING", gamesWonA: 0, gamesWonB: 0 },
      select: { id: true },
    });
    if (lockedSchedule) {
      return {
        ok: false,
        reason: "That opponent isn't on your schedule this season — you only play your assigned matchups.",
      };
    }
  }

  // PENDING by default — opponent confirms via the embed buttons in
  // #results, OR the 2-minute auto-confirm pg-boss job fires and
  // promotes it to CONFIRMED. No standings recompute or announce
  // happens until status flips to CONFIRMED.
  const now = new Date();
  const reportedDeck = input.deck?.trim() || null;
  const reportedStake = input.stake?.trim() || null;
  const pairing = existing
    ? await prisma.match.update({
        where: { id: existing.id },
        data: {
          gamesWonA,
          gamesWonB,
          status: "PENDING",
          reporterId: input.reporterPlayerId,
          reportedAt: now,
          confirmedAt: null,
          reportedDeck,
          reportedStake,
        },
      })
    : await prisma.match.create({
        data: {
          divisionId: division.id,
          playerAId,
          playerBId,
          format: "LEAGUE_BO2",
          gamesWonA,
          gamesWonB,
          status: "PENDING",
          reporterId: input.reporterPlayerId,
          reportedAt: now,
          reportedDeck,
          reportedStake,
        },
      });

  return { ok: true, pairingId: pairing.id, status: existing ? "REREPORTED" : "CREATED" };
}

export type ResolveResult =
  | { ok: true }
  | { ok: false; reason: string };

// confirmSet / disputeSet: actor must be the OPPONENT (not the reporter)
export async function confirmSet(pairingId: string, actorPlayerId: string): Promise<ResolveResult> {
  const pairing = await prisma.match.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true },
  });
  if (!pairing) return { ok: false, reason: "Match not found." };
  if (pairing.status !== "PENDING") {
    return { ok: false, reason: `This match is ${pairing.status.toLowerCase()} — nothing to confirm.` };
  }
  if (pairing.reporterId === actorPlayerId) {
    return { ok: false, reason: "Only the opponent can confirm a match." };
  }
  if (pairing.playerAId !== actorPlayerId && pairing.playerBId !== actorPlayerId) {
    return { ok: false, reason: "You're not part of this match." };
  }
  // Persist winnerId from the score (the report path doesn't set it) so every
  // confirmed match carries a winner — derived here from gamesWon, draw → null.
  const winnerId =
    pairing.gamesWonA > pairing.gamesWonB ? pairing.playerAId
      : pairing.gamesWonB > pairing.gamesWonA ? pairing.playerBId
      : null;
  await prisma.match.update({
    where: { id: pairingId },
    data: { status: "CONFIRMED", confirmedAt: new Date(), winnerId },
  });
  // Fire-and-forget — don't block the caller on Discord network round-trip
  enqueueAnnounceResult(pairingId).catch(() => {});
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  return { ok: true };
}

export interface DisputeOptions {
  // Optional proposal — what the disputer says the result should have
  // been. Surfaced to admin via /admin/disputes for a one-click accept.
  // Pass null/undefined for "I dispute but don't have a specific number"
  // (current Discord-button path).
  proposedGamesWonA?: number | null;
  proposedGamesWonB?: number | null;
  reason?: string | null;
}

// Dispute a match. Either player can dispute. Allowed states:
//   PENDING   — opponent rejecting a fresh report (original button path)
//   CONFIRMED — either player saying "the recorded result is wrong"
// Idempotent: re-disputing an already-DISPUTED row updates proposal/
// reason in place rather than failing.
export async function disputeSet(
  pairingId: string,
  actorPlayerId: string,
  opts: DisputeOptions = {},
): Promise<ResolveResult> {
  const pairing = await prisma.match.findUnique({ where: { id: pairingId } });
  if (!pairing) return { ok: false, reason: "Match not found." };
  if (pairing.status === "CANCELLED") {
    return { ok: false, reason: "This match was cancelled — nothing to dispute." };
  }
  if (pairing.playerAId !== actorPlayerId && pairing.playerBId !== actorPlayerId) {
    return { ok: false, reason: "You're not part of this match." };
  }
  // Allow PENDING, CONFIRMED, DISPUTED (re-dispute with updated proposal).
  // CANCELLED was handled above; any future status added to the enum
  // falls through here so we'd notice immediately rather than silently
  // allow disputes against it.
  const status: string = pairing.status;
  if (status !== "PENDING" && status !== "CONFIRMED" && status !== "DISPUTED") {
    return { ok: false, reason: `Can't dispute a ${status.toLowerCase()} match.` };
  }

  // Sanity-check the proposal if supplied: must be a valid BO2 outcome.
  // Anything weirder (3-0, negative, etc.) is rejected so /admin/disputes
  // can trust the values to one-click accept.
  if (opts.proposedGamesWonA != null && opts.proposedGamesWonB != null) {
    const a = opts.proposedGamesWonA;
    const b = opts.proposedGamesWonB;
    const valid = (a === 2 && b === 0) || (a === 0 && b === 2) || (a === 1 && b === 1);
    if (!valid) {
      return { ok: false, reason: "Proposed result must be 2-0, 1-1, or 0-2." };
    }
  }

  await prisma.match.update({
    where: { id: pairingId },
    data: {
      status: "DISPUTED",
      disputedById: actorPlayerId,
      disputedAt: new Date(),
      disputeProposedGamesWonA: opts.proposedGamesWonA ?? null,
      disputeProposedGamesWonB: opts.proposedGamesWonB ?? null,
      disputeReason: opts.reason ?? null,
      // Re-disputing should re-spawn a thread (the previous one may be
      // resolved/archived). Clear the id so spawnDisputeThread acts.
      disputeThreadId: null,
    },
  });
  // Standings exclude non-CONFIRMED pairings, so flipping to DISPUTED
  // removes this set's contribution. Recompute so the cache reflects it.
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  return { ok: true };
}
