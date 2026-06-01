// Pure web-side report logic. Mirrors src/reporting.ts so the rules
// (one auto-confirmed Pairing per matchup per season, validates both
// players in same division) are identical no matter where the report
// comes from.

import { prisma } from "@/lib/prisma";
import { recomputeDivisionStandings } from "@/lib/standings-cache";

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

  const now = new Date();
  const pairing = existing
    ? await prisma.pairing.update({
        where: { id: existing.id },
        data: { gamesWonA, gamesWonB, status: "CONFIRMED", reporterId: reporter.id, reportedAt: now, confirmedAt: now },
      })
    : await prisma.pairing.create({
        data: {
          divisionId: division.id,
          playerAId, playerBId, gamesWonA, gamesWonB,
          status: "CONFIRMED",
          reporterId: reporter.id,
          reportedAt: now,
          confirmedAt: now,
        },
      });
  recomputeDivisionStandings(division.id).catch(() => {});

  return { ok: true, pairingId: pairing.id, created: !existing };
}
