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
import { resyncSeasonSchedules } from "@/lib/schedule-sync";
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
  // Optional per-game detail (index 0 = game 1, 1 = game 2): the deck/stake it
  // was played on and the WINNER's leftover lives. For matches played outside the
  // guided flow. Winners are derived from `result`. Empty entries are fine.
  games?: Array<{ deck?: string | null; stake?: string | null; winnerLives?: number | null }>;
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

  // Clear prior per-game rows so they can't contradict the new result.
  await prisma.game.deleteMany({ where: { matchId: match.id } });

  // Recreate per-game rows when the admin supplied any deck/stake/lives detail
  // (for an outside-the-flow match). A BO2 is 2 games; winners come from result.
  const perGame = (args.games ?? []).slice(0, 2);
  const hasDetail = perGame.some(
    (g) => (g?.deck && g.deck.trim()) || (g?.stake && g.stake.trim()) || g?.winnerLives != null,
  );
  if (hasDetail) {
    const winners =
      result === "2-0"
        ? [playerAId, playerAId]
        : result === "0-2"
          ? [playerBId, playerBId]
          : [playerAId, playerBId]; // 1-1: game 1 = A's win, game 2 = B's win
    await prisma.game.createMany({
      data: [0, 1].map((i) => {
        const g = perGame[i] ?? {};
        return {
          matchId: match.id,
          num: i + 1,
          firstPlayerId: canonA,
          winnerId: winners[i] ?? null,
          winnerLives: g.winnerLives ?? null,
          deck: g.deck?.trim() || null,
          stake: g.stake?.trim() || null,
        };
      }),
    });
  }

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
  // Clear stale per-game rows — an override only sets the aggregate, so old
  // game winners/lives no longer match the corrected result.
  await prisma.game.deleteMany({ where: { matchId: updated.id } });
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
  // A DQ/forfeit awards a flat 2-0 — drop any prior per-game rows so a web
  // report's lives can't linger and contradict it.
  await prisma.game.deleteMany({ where: { matchId: match.id } });
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

// DQ a NO-SHOW: award every one of the player's scheduled-but-UNPLAYED matches to
// the opponent as a 2-0 by forfeit, and KEEP the player active (unlike
// voidPlayerInDivision, which cancels + drops with no 2-0s). Kept-active means
// they finish last on these losses, so they absorb their own relegation slot
// (sparing a real player) and come back relegated whenever they sign up again.
// Only pristine unplayed PENDING pairings are touched — any already-played result
// is left as-is. No per-match announcements (avoids spamming #results).
export async function dqForfeitNoShow(args: {
  divisionId: string;
  playerId: string;
  reason: string;
  actor: AuditActor;
}): Promise<{ ok: true; divisionId: string; forfeited: number } | { ok: false; reason: string }> {
  const { divisionId, playerId, actor } = args;
  const reason = args.reason?.trim();
  if (!divisionId || !playerId || !reason) {
    return { ok: false, reason: "Need a division, a player, and a reason." };
  }
  const member = await prisma.divisionMember.findFirst({ where: { divisionId, playerId } });
  if (!member) return { ok: false, reason: "That player isn't in this division." };

  // Scheduled-but-unplayed = PENDING assigned pairings with no result yet.
  const unplayed = await prisma.match.findMany({
    where: {
      divisionId,
      format: "LEAGUE_BO2",
      status: "PENDING",
      gamesWonA: 0,
      gamesWonB: 0,
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: { id: true, playerAId: true, playerBId: true },
  });
  if (unplayed.length === 0) {
    return { ok: false, reason: "That player has no unplayed scheduled matches to forfeit." };
  }

  const now = new Date();
  for (const m of unplayed) {
    const opponentId = m.playerAId === playerId ? m.playerBId : m.playerAId;
    const winnerIsA = opponentId === m.playerAId;
    await prisma.match.update({
      where: { id: m.id },
      data: {
        gamesWonA: winnerIsA ? 2 : 0,
        gamesWonB: winnerIsA ? 0 : 2,
        winnerId: opponentId,
        status: "CONFIRMED",
        reportedAt: now,
        confirmedAt: now,
        adminOverrideBy: actor.discordId,
        adminOverrideReason: "forfeit / DQ (no-show)",
        forfeit: true,
        forfeitReason: reason,
      },
    });
    // A forfeit is a flat 2-0 — clear any stray per-game rows.
    await prisma.game.deleteMany({ where: { matchId: m.id } });
  }

  await recordAudit({
    actor,
    action: "player.dq-forfeit",
    targetType: "Player",
    targetId: playerId,
    summary: `DQ (forfeit no-show): awarded ${unplayed.length} opponent(s) a 2-0 in division ${divisionId}; player kept active`,
    metadata: { divisionId, playerId, forfeited: unplayed.length, reason },
  });
  await recomputeDivisionStandings(divisionId).catch((err) =>
    console.warn("[match-admin] standings recompute failed:", err),
  );
  return { ok: true, divisionId, forfeited: unplayed.length };
}

// Void a single game: record a CONFIRMED 0-0. Counts as PLAYED/finished (so the
// pair isn't flagged as a remaining match) but awards no points and is neither a
// win, loss, nor draw. For a misreport / agreed no-contest. Mirrors the bot's
// /admin void-match. Doesn't announce (nothing to celebrate).
export async function voidGame(args: {
  divisionId: string;
  p1Id: string;
  p2Id: string;
  reason?: string;
  actor: AuditActor;
}): Promise<MatchAdminOutcome> {
  const { divisionId, p1Id, p2Id, actor } = args;
  const reason = args.reason?.trim() ?? "";
  if (!divisionId || !p1Id || !p2Id || p1Id === p2Id) {
    return { ok: false, reason: "Need a division and two distinct players." };
  }
  const [canonA, canonB] = canonicalPair(p1Id, p2Id);
  const now = new Date();
  const overrideReason = `void 0-0${reason ? `: ${reason}` : ""}`;
  const match = await prisma.match.upsert({
    where: {
      divisionId_playerAId_playerBId_format: { divisionId, playerAId: canonA, playerBId: canonB, format: "LEAGUE_BO2" },
    },
    create: {
      divisionId,
      playerAId: canonA,
      playerBId: canonB,
      format: "LEAGUE_BO2",
      gamesWonA: 0,
      gamesWonB: 0,
      winnerId: null,
      status: "CONFIRMED",
      reportedAt: now,
      confirmedAt: now,
      adminOverrideBy: actor.discordId,
      adminOverrideReason: overrideReason,
    },
    update: {
      gamesWonA: 0,
      gamesWonB: 0,
      winnerId: null,
      status: "CONFIRMED",
      confirmedAt: now,
      forfeit: false,
      forfeitReason: null,
      adminOverrideBy: actor.discordId,
      adminOverrideReason: overrideReason,
    },
  });
  // A void is 0-0 with no winner — remove any per-game rows so stale lives
  // don't feed the tiebreaker for a voided match.
  await prisma.game.deleteMany({ where: { matchId: match.id } });
  await recordAudit({
    actor,
    action: "match.void",
    targetType: "Match",
    targetId: match.id,
    summary: `Voided game 0-0 between ${p1Id} and ${p2Id}`,
    metadata: { p1Id, p2Id, divisionId, reason: reason || null },
  });
  await afterWrite(match.id, divisionId, false);
  return { ok: true, matchId: match.id, divisionId };
}

// DQ a player by VOIDING their division: cancel all their league matches and
// drop them. No 2-0s to opponents, no losses to the player (standings only
// count active members' confirmed matches). Mirrors the bot's /admin void-player.
export async function voidPlayerInDivision(args: {
  divisionId: string;
  playerId: string;
  reason?: string;
  actor: AuditActor;
}): Promise<MatchAdminOutcome> {
  const { divisionId, playerId, actor } = args;
  const reason = args.reason?.trim() ?? "";
  if (!divisionId || !playerId) return { ok: false, reason: "Need a division and a player." };
  const member = await prisma.divisionMember.findFirst({ where: { divisionId, playerId } });
  if (!member) return { ok: false, reason: "That player isn't in this division." };

  const voided = await prisma.match.updateMany({
    where: {
      divisionId,
      format: "LEAGUE_BO2",
      status: { in: ["CONFIRMED", "PENDING", "DISPUTED"] },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    data: { status: "CANCELLED", adminOverrideBy: actor.discordId, adminOverrideReason: "DQ void" },
  });
  await prisma.divisionMember.update({
    where: { id: member.id },
    data: { status: "DROPPED", droppedAt: new Date() },
  });
  // Refill the voided player's ex-opponents (their matches are now CANCELLED).
  await resyncSeasonSchedules(member.seasonId);
  await recordAudit({
    actor,
    action: "player.void",
    targetType: "Player",
    targetId: playerId,
    summary: `DQ void: removed player + voided ${voided.count} match(es) in division ${divisionId}`,
    metadata: { divisionId, playerId, voidedMatches: voided.count, reason: reason || null },
  });
  await recomputeDivisionStandings(divisionId).catch((err) =>
    console.warn("[match-admin] standings recompute failed:", err),
  );
  return { ok: true, matchId: "", divisionId };
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

// Resolve a tie of ANY size from a per-player PLACEMENT map (1 = winner) where
// ties are allowed: players given the SAME place stay tied with each other.
// We write one showdown per pair with DIFFERENT places (lower place wins) and
// none between equal-placed players — so e.g. {A:1, B:2, C:2} records A beating
// B and C while B & C are left tied (broken by the normal wins/draws/name
// fallback). Exactly "pick the winner(s), leave the rest tied".
//
// Authoritative: first clears existing showdowns AMONG the involved group, so
// re-submitting (including turning a forced order back into a tie) fully takes
// effect. Showdowns involving players outside the group are untouched. Reuses
// the existing pairwise shootout tiebreaker — no schema or scoring changes.
export async function resolveTieWithShowdowns(args: {
  divisionId: string;
  placements: Array<{ playerId: string; place: number }>;
  actor: AuditActor;
}): Promise<{ ok: true; divisionId: string; showdownsWritten: number } | { ok: false; reason: string }> {
  const { divisionId, actor } = args;
  // First place per player wins; drop blanks/dupes.
  const byPlayer = new Map<string, number>();
  for (const p of args.placements) {
    if (p.playerId && Number.isFinite(p.place) && !byPlayer.has(p.playerId)) byPlayer.set(p.playerId, p.place);
  }
  const involved = [...byPlayer.entries()].map(([playerId, place]) => ({ playerId, place }));
  if (involved.length < 2) return { ok: false, reason: "Assign a place to at least two players." };
  if (new Set(involved.map((e) => e.place)).size < 2) {
    return { ok: false, reason: "Everyone has the same place — give the winner a lower number (e.g. 1, 2, 2)." };
  }

  const ids = involved.map((e) => e.playerId);
  // Authoritative reset for this group's showdowns.
  await prisma.match.deleteMany({
    where: { divisionId, format: "SHOOTOUT_BO1", playerAId: { in: ids }, playerBId: { in: ids } },
  });

  const now = new Date();
  let showdownsWritten = 0;
  for (let i = 0; i < involved.length; i++) {
    for (let j = i + 1; j < involved.length; j++) {
      const a = involved[i]!;
      const b = involved[j]!;
      if (a.place === b.place) continue; // equal → stay tied, no showdown
      const winnerId = a.place < b.place ? a.playerId : b.playerId;
      const [canonA, canonB] = canonicalPair(a.playerId, b.playerId);
      await prisma.match.create({
        data: {
          divisionId,
          playerAId: canonA,
          playerBId: canonB,
          format: "SHOOTOUT_BO1",
          gamesWonA: winnerId === canonA ? 1 : 0,
          gamesWonB: winnerId === canonB ? 1 : 0,
          winnerId,
          status: "CONFIRMED",
          reportedAt: now,
          confirmedAt: now,
          recordedBy: actor.discordId,
        },
      });
      showdownsWritten++;
    }
  }

  await recordAudit({
    actor,
    action: "showdown.resolve-tie",
    targetType: "Division",
    targetId: divisionId,
    summary: `Resolved a tie among ${involved.length} players (${showdownsWritten} showdowns)`,
    metadata: { placements: involved },
  });
  // One recompute after the whole batch (covers the all-tied-after-clear case).
  recomputeDivisionStandings(divisionId).catch((err) =>
    console.warn("[match-admin] standings recompute failed:", err),
  );
  return { ok: true, divisionId, showdownsWritten };
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
