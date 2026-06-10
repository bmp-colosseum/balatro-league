// Canonical admin result-mutation operations. ONE home for the five things an
// admin can do to a match result, so every surface (division page, players page,
// disputes, the /admin/results page) behaves identically: write → recompute
// standings → audit → (optionally) announce. Replaces the hand-rolled
// prisma.match writes that were duplicated across those surfaces.
//
// These are plain async functions (not server actions) — the server actions
// that call them own auth (requireAdmin) and revalidatePath. Every op records
// an audit event stamped with the acting admin, closing the "who did this?" gap.

import { prisma } from "@/lib/prisma";
import { enqueueAnnounceResult } from "@/lib/queue";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { recordAudit, type AuditActor } from "@/lib/audit";

export type ResultStr = "2-0" | "1-1" | "0-2";

function gamesFromResult(r: ResultStr): { a: number; b: number } {
  if (r === "2-0") return { a: 2, b: 0 };
  if (r === "0-2") return { a: 0, b: 2 };
  return { a: 1, b: 1 };
}

// Pairing convention: playerAId < playerBId so the unique constraint
// (divisionId, playerAId, playerBId, format) catches duplicates regardless of
// the order the two players were passed in.
function canonicalPair(p1: string, p2: string): [string, string] {
  return p1 < p2 ? [p1, p2] : [p2, p1];
}

function winnerFor(canonA: string, canonB: string, gamesWonA: number, gamesWonB: number): string | null {
  if (gamesWonA > gamesWonB) return canonA;
  if (gamesWonB > gamesWonA) return canonB;
  return null;
}

async function afterWrite(matchId: string, divisionId: string, announce: boolean): Promise<void> {
  recomputeDivisionStandings(divisionId).catch((err) =>
    console.warn("[match-admin] standings recompute failed:", err),
  );
  if (announce) {
    enqueueAnnounceResult(matchId).catch((err) =>
      console.warn("[match-admin] announce enqueue failed:", err),
    );
  }
}

export type MatchAdminOutcome =
  | { ok: true; matchId: string; divisionId: string }
  | { ok: false; reason: string };

// Record (or overwrite) a played best-of-2 result for any pair. Admin authority —
// no "is the caller one of the players" check (that's the public report path).
export async function recordResult(args: {
  divisionId: string;
  playerAId: string;
  playerBId: string;
  result: ResultStr;
  actor: AuditActor;
  reason?: string;
  deck?: string | null;
  stake?: string | null;
  announce?: boolean;
}): Promise<MatchAdminOutcome> {
  const { divisionId, playerAId, playerBId, result, actor } = args;
  if (!divisionId || !playerAId || !playerBId || playerAId === playerBId) {
    return { ok: false, reason: "Need a division and two distinct players." };
  }
  const [canonA, canonB] = canonicalPair(playerAId, playerBId);
  const aIsCanonA = playerAId === canonA;
  const games = gamesFromResult(result);
  const gamesWonA = aIsCanonA ? games.a : games.b;
  const gamesWonB = aIsCanonA ? games.b : games.a;
  const winnerId = winnerFor(canonA, canonB, gamesWonA, gamesWonB);
  const now = new Date();
  const reason = args.reason?.trim() || "recorded via dashboard";

  const match = await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: { divisionId, playerAId: canonA, playerBId: canonB, format: "LEAGUE_BO2" },
    },
    create: {
      divisionId,
      playerAId: canonA,
      playerBId: canonB,
      format: "LEAGUE_BO2",
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      reportedAt: now,
      confirmedAt: now,
      reportedDeck: args.deck?.trim() || null,
      reportedStake: args.stake?.trim() || null,
      adminOverrideBy: actor.discordId,
      adminOverrideReason: reason,
    },
    update: {
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      confirmedAt: now,
      // Recording a played result clears any prior forfeit flag.
      forfeit: false,
      forfeitReason: null,
      adminOverrideBy: actor.discordId,
      adminOverrideReason: reason,
    },
  });

  await recordAudit({
    actor,
    action: "match.record",
    targetType: "Match",
    targetId: match.id,
    summary: `Recorded ${gamesWonA}-${gamesWonB} (${canonA} vs ${canonB})`,
    metadata: { divisionId, playerAId: canonA, playerBId: canonB, result, reason },
  });
  await afterWrite(match.id, divisionId, args.announce ?? true);
  return { ok: true, matchId: match.id, divisionId };
}

// Correct an existing match's score by id. Clears any forfeit/DQ flag (a played
// result is no longer "by DQ"). For undoing a DQ entirely, use undoResult.
export async function overrideResult(args: {
  matchId: string;
  result: ResultStr;
  actor: AuditActor;
  reason?: string;
  announce?: boolean;
}): Promise<MatchAdminOutcome> {
  const { matchId, result, actor } = args;
  if (!matchId) return { ok: false, reason: "Need a match id." };
  const games = gamesFromResult(result);
  const existing = await prisma.match.findUnique({ where: { id: matchId }, select: { id: true, playerAId: true, playerBId: true } });
  if (!existing) return { ok: false, reason: "Match not found." };
  const winnerId = winnerFor(existing.playerAId, existing.playerBId, games.a, games.b);
  const reason = args.reason?.trim() || "override via dashboard";

  const updated = await prisma.match.update({
    where: { id: matchId },
    data: {
      gamesWonA: games.a,
      gamesWonB: games.b,
      winnerId,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      forfeit: false,
      forfeitReason: null,
      adminOverrideBy: actor.discordId,
      adminOverrideReason: reason,
    },
  });
  await recordAudit({
    actor,
    action: "match.override",
    targetType: "Match",
    targetId: updated.id,
    summary: `Overrode to ${games.a}-${games.b}`,
    metadata: { matchId, result, reason },
  });
  await afterWrite(updated.id, updated.divisionId, args.announce ?? true);
  return { ok: true, matchId: updated.id, divisionId: updated.divisionId };
}

// Award a 2-0 win by forfeit / DQ. Upserts so it records a new DQ or fixes a
// wrong existing result in place. Reason is admin-only (forfeitReason + audit).
export async function forfeitResult(args: {
  divisionId: string;
  winnerId: string;
  loserId: string;
  reason: string;
  actor: AuditActor;
  announce?: boolean;
}): Promise<MatchAdminOutcome> {
  const { divisionId, winnerId, loserId, actor } = args;
  const reason = args.reason?.trim();
  if (!divisionId || !winnerId || !loserId || winnerId === loserId || !reason) {
    return { ok: false, reason: "Need a division, distinct winner + loser, and a reason." };
  }
  const [canonA, canonB] = canonicalPair(winnerId, loserId);
  const winnerIsA = winnerId === canonA;
  const gamesWonA = winnerIsA ? 2 : 0;
  const gamesWonB = winnerIsA ? 0 : 2;
  const now = new Date();

  const match = await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: { divisionId, playerAId: canonA, playerBId: canonB, format: "LEAGUE_BO2" },
    },
    create: {
      divisionId,
      playerAId: canonA,
      playerBId: canonB,
      format: "LEAGUE_BO2",
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      reportedAt: now,
      confirmedAt: now,
      adminOverrideBy: actor.discordId,
      adminOverrideReason: "forfeit / DQ",
      forfeit: true,
      forfeitReason: reason,
    },
    update: {
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      confirmedAt: now,
      adminOverrideBy: actor.discordId,
      adminOverrideReason: "forfeit / DQ",
      forfeit: true,
      forfeitReason: reason,
    },
  });
  await recordAudit({
    actor,
    action: "match.forfeit",
    targetType: "Match",
    targetId: match.id,
    summary: `Forfeit win (2-0 by DQ), winner ${winnerId}`,
    metadata: { winnerId, loserId, reason, divisionId },
  });
  await afterWrite(match.id, divisionId, args.announce ?? true);
  return { ok: true, matchId: match.id, divisionId };
}

// Record (or overwrite) a 1-game showdown to break a tied promo/relegation spot.
export async function recordShowdown(args: {
  divisionId: string;
  p1Id: string;
  p2Id: string;
  winnerId: string;
  actor: AuditActor;
  notes?: string;
}): Promise<MatchAdminOutcome> {
  const { divisionId, p1Id, p2Id, winnerId, actor } = args;
  if (!divisionId || !p1Id || !p2Id || p1Id === p2Id) {
    return { ok: false, reason: "Need a division and two distinct players." };
  }
  if (winnerId !== p1Id && winnerId !== p2Id) {
    return { ok: false, reason: "Winner must be one of the two players." };
  }
  const [canonA, canonB] = canonicalPair(p1Id, p2Id);
  const gamesWonA = winnerId === canonA ? 1 : 0;
  const gamesWonB = winnerId === canonB ? 1 : 0;
  const now = new Date();

  const match = await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: { divisionId, playerAId: canonA, playerBId: canonB, format: "SHOOTOUT_BO1" },
    },
    create: {
      divisionId,
      playerAId: canonA,
      playerBId: canonB,
      format: "SHOOTOUT_BO1",
      gamesWonA,
      gamesWonB,
      winnerId,
      status: "CONFIRMED",
      reportedAt: now,
      confirmedAt: now,
      recordedBy: actor.discordId,
    },
    update: { gamesWonA, gamesWonB, winnerId, status: "CONFIRMED", confirmedAt: now, recordedBy: actor.discordId },
  });
  await recordAudit({
    actor,
    action: "showdown.record",
    targetType: "Match",
    targetId: match.id,
    summary: `Showdown winner ${winnerId}${args.notes ? ` — ${args.notes}` : ""}`,
    metadata: { divisionId, p1Id, p2Id, winnerId, notes: args.notes ?? null },
  });
  // Showdowns don't announce (they're tiebreakers, not regular results).
  await afterWrite(match.id, divisionId, false);
  return { ok: true, matchId: match.id, divisionId };
}

// Delete a match outright (undo a result/DQ/showdown). Standings fall back to
// the next tiebreaker. Returns the affected division so the caller can recompute.
export async function undoResult(args: {
  matchId: string;
  actor: AuditActor;
}): Promise<MatchAdminOutcome> {
  const { matchId, actor } = args;
  if (!matchId) return { ok: false, reason: "Need a match id." };
  const existing = await prisma.match.findUnique({ where: { id: matchId }, select: { id: true, divisionId: true, format: true } });
  if (!existing) return { ok: false, reason: "Match not found." };
  await prisma.match.delete({ where: { id: matchId } });
  await recordAudit({
    actor,
    action: "match.undo",
    targetType: "Match",
    targetId: matchId,
    summary: `Deleted ${existing.format} match`,
    metadata: { matchId, divisionId: existing.divisionId, format: existing.format },
  });
  await afterWrite(matchId, existing.divisionId, false);
  return { ok: true, matchId, divisionId: existing.divisionId };
}
