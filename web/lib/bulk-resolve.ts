// Shell for the admin bulk-resolve queue (/admin/resolve): gathers every
// requested match + its division's members, hands them to the pure core
// (lib/bulk-resolve-core.ts) to decide who's allowed, then writes exactly the
// allowed ones via the SAME per-match mutations lib/match-admin.ts already
// uses for a single match -- void = writeCancelMatch, forfeit-a/b =
// writeForfeitResult. Those write-only halves skip their own standings
// recompute/announce on purpose: this module batches recompute once per
// division touched, not once per match (see applyBulkResolve below), and
// never announces (same "quiet" convention voidGame/dqForfeitNoShow/
// voidPlayerInDivision already use for an admin cleanup op, not a result worth
// celebrating in #results).

import { prisma } from "@/lib/prisma";
import type { AuditActor } from "@/lib/audit";
import { writeForfeitResult, writeCancelMatch, type MatchAdminOutcome } from "@/lib/match-admin";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import {
  classifyUnresolved,
  planBulkAction,
  type BulkAction,
  type DivisionMemberInput,
  type UnresolvedMatchInput,
  type UnresolvedRow,
} from "@/lib/bulk-resolve-core";

export type { BulkAction } from "@/lib/bulk-resolve-core";

export interface ApplyBulkResolveArgs {
  ids: readonly string[];
  action: BulkAction;
  reason: string;
  actor: AuditActor;
}

export interface ApplyBulkResolveResult {
  applied: string[];
  refused: Array<{ id: string; reason: string }>;
}

interface RawMatch {
  id: string;
  divisionId: string;
  playerAId: string;
  playerBId: string;
  status: string;
  createdAt: Date;
  reportedAt: Date | null;
  confirmedAt: Date | null;
  disputedAt: Date | null;
}

interface RawMember {
  divisionId: string;
  playerId: string;
  status: string;
  droppedAt: Date | null;
  checkinStatus: string | null;
  checkinAt: Date | null;
  player: { displayName: string };
}

function toMatchInput(m: RawMatch): UnresolvedMatchInput {
  return {
    id: m.id,
    divisionId: m.divisionId,
    playerAId: m.playerAId,
    playerBId: m.playerBId,
    status: m.status,
    createdAt: m.createdAt,
    reportedAt: m.reportedAt,
    confirmedAt: m.confirmedAt,
    disputedAt: m.disputedAt,
  };
}

function toMemberInput(m: RawMember): DivisionMemberInput {
  return {
    playerId: m.playerId,
    displayName: m.player.displayName,
    status: m.status,
    droppedAt: m.droppedAt,
    checkinStatus: m.checkinStatus as DivisionMemberInput["checkinStatus"],
    checkinAt: m.checkinAt,
  };
}

// Gather every requested match REGARDLESS of its current status -- so an id
// that's already resolved (or never existed) still gets looked up and comes
// back with a specific refusal from planBulkAction instead of silently
// vanishing -- plus every member of every division those matches belong to,
// then classify each match into the queue's row view.
async function loadRows(ids: readonly string[], now: Date): Promise<Map<string, UnresolvedRow>> {
  const matches: RawMatch[] = await prisma.match.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      divisionId: true,
      playerAId: true,
      playerBId: true,
      status: true,
      createdAt: true,
      reportedAt: true,
      confirmedAt: true,
      disputedAt: true,
    },
  });

  const divisionIds = [...new Set(matches.map((m) => m.divisionId))];
  const members: RawMember[] = divisionIds.length
    ? await prisma.divisionMember.findMany({
        where: { divisionId: { in: divisionIds } },
        select: {
          divisionId: true,
          playerId: true,
          status: true,
          droppedAt: true,
          checkinStatus: true,
          checkinAt: true,
          player: { select: { displayName: true } },
        },
      })
    : [];

  const membersByDivision = new Map<string, DivisionMemberInput[]>();
  for (const m of members) {
    const list = membersByDivision.get(m.divisionId) ?? [];
    list.push(toMemberInput(m));
    membersByDivision.set(m.divisionId, list);
  }

  const rows = matches.map((m) => classifyUnresolved(toMatchInput(m), membersByDivision.get(m.divisionId) ?? [], now));
  return new Map(rows.map((r) => [r.matchId, r]));
}

// Routes one allowed row to the same per-match write lib/match-admin.ts uses
// for the equivalent single-match admin action. No "both players lose" shape
// exists on Match (one winnerId, one gamesWonA/B pair) -- so double-forfeit is
// represented as a void (status CANCELLED) with a distinguishing reason
// prefix and its own audit action key, not a real double-loss result.
async function writeForAction(
  action: BulkAction,
  row: UnresolvedRow,
  reason: string,
  actor: AuditActor,
): Promise<MatchAdminOutcome> {
  switch (action) {
    case "void":
      return writeCancelMatch({ matchId: row.matchId, reason, actor });
    case "double-forfeit":
      return writeCancelMatch({
        matchId: row.matchId,
        reason: `double forfeit: ${reason}`,
        actor,
        auditAction: "match.double-forfeit",
      });
    case "forfeit-a":
      return writeForfeitResult({
        divisionId: row.divisionId,
        winnerId: row.playerB.playerId,
        loserId: row.playerA.playerId,
        reason,
        actor,
      });
    case "forfeit-b":
      return writeForfeitResult({
        divisionId: row.divisionId,
        winnerId: row.playerA.playerId,
        loserId: row.playerB.playerId,
        reason,
        actor,
      });
    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled bulk action: ${String(exhaustive)}`);
    }
  }
}

export async function applyBulkResolve(args: ApplyBulkResolveArgs): Promise<ApplyBulkResolveResult> {
  const ids = [...new Set(args.ids.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { applied: [], refused: [] };

  const reason = args.reason.trim();
  if (!reason) {
    return { applied: [], refused: ids.map((id) => ({ id, reason: "A reason is required." })) };
  }

  const now = new Date();
  const byId = await loadRows(ids, now);
  const decisions = planBulkAction([...byId.values()], ids, args.action);

  const applied: string[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  const touchedDivisions = new Set<string>();

  // Sequential, not one DB transaction: writeForfeitResult/writeCancelMatch
  // each read+write through the shared `prisma` client with no injectable tx
  // handle, so wrapping the batch in prisma.$transaction would mean threading
  // a tx client through lib/match-admin.ts -- out of scope for this leaf.
  // Each id gets its own try/catch instead, so one failure doesn't sink the
  // rest of the batch; a per-id result list is still returned either way.
  for (const decision of decisions) {
    if (!decision.allowed) {
      refused.push({ id: decision.id, reason: decision.reason! });
      continue;
    }
    const row = byId.get(decision.id)!;
    try {
      const outcome = await writeForAction(args.action, row, reason, args.actor);
      if (outcome.ok) {
        applied.push(decision.id);
        touchedDivisions.add(outcome.divisionId);
      } else {
        refused.push({ id: decision.id, reason: outcome.reason });
      }
    } catch (err) {
      refused.push({ id: decision.id, reason: err instanceof Error ? err.message : "Unexpected error." });
    }
  }

  // Standings recompute happens ONCE per affected division here, not once per
  // match inside the per-match helpers above.
  await Promise.all(
    [...touchedDivisions].map((divisionId) =>
      recomputeDivisionStandings(divisionId).catch((err) =>
        console.warn("[bulk-resolve] standings recompute failed:", err),
      ),
    ),
  );

  return { applied, refused };
}
