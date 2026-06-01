// Pure web-side report logic. Mirrors src/reporting.ts so the rules
// (one pending-then-confirmed Pairing per matchup per season,
// validates both players in same division) are identical no matter
// where the report comes from.

import { prisma } from "@/lib/prisma";
import { enqueueReportAutoConfirm, enqueueReportPostPending } from "@/lib/queue";

export type ReportResultStr = "2-0" | "1-1" | "0-2";

function gamesFromResult(r: ReportResultStr): { a: number; b: number } {
  if (r === "2-0") return { a: 2, b: 0 };
  if (r === "0-2") return { a: 0, b: 2 };
  return { a: 1, b: 1 };
}

export type ReportOutcome =
  | { ok: true; pairingId: string; created: boolean }
  | { ok: false; reason: string };

export async function reportSetFromWeb(
  reporterDiscordId: string,
  opponentPlayerId: string,
  result: ReportResultStr,
): Promise<ReportOutcome> {
  const reporter = await prisma.player.findUnique({ where: { discordId: reporterDiscordId } });
  if (!reporter) return { ok: false, reason: "You don't have a Player record — ask an admin to add you." };
  if (reporter.id === opponentPlayerId) {
    return { ok: false, reason: "Can't report against yourself." };
  }

  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true, visibility: "PUBLIC" },
  });
  if (!activeSeason) return { ok: false, reason: "No active season right now." };

  const sharedMembership = await prisma.divisionMember.findFirst({
    where: {
      playerId: reporter.id,
      status: "ACTIVE",
      division: { seasonId: activeSeason.id },
    },
    include: {
      division: {
        include: { members: { where: { playerId: opponentPlayerId, status: "ACTIVE" } } },
      },
    },
  });
  if (!sharedMembership || sharedMembership.division.members.length === 0) {
    return { ok: false, reason: "You and your opponent aren't in the same active division." };
  }

  const division = sharedMembership.division;
  const [playerAId, playerBId] = reporter.id < opponentPlayerId
    ? [reporter.id, opponentPlayerId]
    : [opponentPlayerId, reporter.id];
  const reporterIsA = reporter.id === playerAId;
  const games = gamesFromResult(result);
  const gamesWonA = reporterIsA ? games.a : games.b;
  const gamesWonB = reporterIsA ? games.b : games.a;

  const existing = await prisma.pairing.findUnique({
    where: { divisionId_playerAId_playerBId: { divisionId: division.id, playerAId, playerBId } },
  });
  if (existing && existing.status === "CONFIRMED") {
    return {
      ok: false,
      reason: `Already recorded ${existing.gamesWonA}-${existing.gamesWonB}. Ask an admin to use /admin override-result if it needs to change.`,
    };
  }
  if (existing && existing.status === "PENDING") {
    return {
      ok: false,
      reason: "There's already a pending report for this match — opponent needs to confirm/dispute first (or wait for the 2-min auto-confirm).",
    };
  }

  // PENDING by default — bot posts the public embed + opponent confirms
  // or 2-min auto-confirm fires. No standings update yet.
  const now = new Date();
  const pairing = existing
    ? await prisma.pairing.update({
        where: { id: existing.id },
        data: { gamesWonA, gamesWonB, status: "PENDING", reporterId: reporter.id, reportedAt: now, confirmedAt: null },
      })
    : await prisma.pairing.create({
        data: {
          divisionId: division.id,
          playerAId, playerBId, gamesWonA, gamesWonB,
          status: "PENDING",
          reporterId: reporter.id,
          reportedAt: now,
        },
      });
  // Hand off the Discord-side work to the bot via pg-boss. Both jobs
  // are idempotent on the worker side — auto-confirm no-ops if status
  // already changed, post-pending no-ops if the message already exists.
  enqueueReportPostPending(pairing.id).catch((err) => console.warn("[web report] post-pending enqueue:", err));
  enqueueReportAutoConfirm(pairing.id).catch((err) => console.warn("[web report] auto-confirm enqueue:", err));

  return { ok: true, pairingId: pairing.id, created: !existing };
}
