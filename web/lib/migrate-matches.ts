// EXPAND-phase backfill: convert the legacy Pairing + Shootout + MatchSession
// JSON into the unified relational Match / Game / Ban tables. Idempotent and
// re-runnable — Match reuses the source row's id, and Game/Ban upsert on their
// natural keys, so you can run it, eyeball the counts, and run it again.
//
// It only READS the legacy tables and WRITES the new ones — nothing legacy is
// modified or dropped, and the live MatchSession driver is untouched. Safe to
// run against prod with matches in flight (in-progress sessions simply have no
// completed game JSON yet, so they contribute no Game rows until they finish
// under the new writers).

import { prisma } from "@/lib/prisma";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { projectDivisionMatches } from "@/lib/match-projection";

export interface BackfillResult {
  divisions: number; // divisions re-projected
  matches: number; // total Match rows after backfill
  games: number; // total Game rows
  poolRows: number; // total GameDeck (pool) rows
}

// Sweep every division that has legacy results and re-project it into the
// unified Match/Game/GameDeck model, reusing the exact same projection the
// live recompute hook uses (single source of truth). Idempotent.
export async function backfillMatches(actor: AuditActor): Promise<BackfillResult> {
  const [pairDivs, shootDivs] = await Promise.all([
    prisma.pairing.findMany({ distinct: ["divisionId"], select: { divisionId: true } }),
    prisma.shootout.findMany({ distinct: ["divisionId"], select: { divisionId: true } }),
  ]);
  const divisionIds = [
    ...new Set([...pairDivs.map((d) => d.divisionId), ...shootDivs.map((d) => d.divisionId)]),
  ];

  for (const id of divisionIds) {
    await projectDivisionMatches(id);
  }

  const [matches, games, poolRows] = await Promise.all([
    prisma.match.count(),
    prisma.game.count(),
    prisma.gameDeck.count(),
  ]);

  recordAudit({
    actor,
    action: "migrate.matches-backfill",
    targetType: "Match",
    targetId: "all",
    summary: `Backfilled ${divisionIds.length} divisions → ${matches} matches, ${games} games, ${poolRows} pool rows`,
    metadata: { divisions: divisionIds.length, matches, games, poolRows },
  });

  return { divisions: divisionIds.length, matches, games, poolRows };
}
