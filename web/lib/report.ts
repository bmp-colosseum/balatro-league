// Pure web-side report logic. Mirrors src/reporting.ts so the rules
// (one pending-then-confirmed Pairing per matchup per season,
// validates both players in same division) are identical no matter
// where the report comes from.

import { prisma } from "@/lib/prisma";
import {
  enqueueAnnounceResult,
  enqueueDisputeSpawnThread,
  enqueueDm,
} from "@/lib/queue";
import { recomputeDivisionStandings } from "@/lib/standings-cache";

// Compose the DM body sent to the opponent when a web-side report
// confirms a match. Phrased from the opponent's POV so they don't have
// to flip the score in their head — and includes a direct path to the
// inline dispute UI on /report if the result is wrong.
function buildOpponentReportDm(args: {
  reporterDisplayName: string;
  reporterGames: number;
  opponentGames: number;
  divisionName: string;
  siteUrl: string;
}): string {
  const { reporterDisplayName, reporterGames, opponentGames, divisionName, siteUrl } = args;
  const verdict =
    reporterGames > opponentGames
      ? `**${reporterDisplayName}** reported a **${reporterGames}-${opponentGames}** win over you in ${divisionName}.`
      : reporterGames < opponentGames
        ? `**${reporterDisplayName}** reported a **${reporterGames}-${opponentGames}** loss to you in ${divisionName}.`
        : `**${reporterDisplayName}** reported a **1-1 draw** against you in ${divisionName}.`;
  return (
    `📝 ${verdict}\n\n` +
    `It's already recorded in standings. **If that's wrong**, open ${siteUrl}/report, find this match in "Your recent matches", and click **Dispute** — a League Helper will sort it out.`
  );
}

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
  combo?: { deck?: string | null; stake?: string | null },
): Promise<ReportOutcome> {
  const reporter = await prisma.player.findUnique({ where: { discordId: reporterDiscordId } });
  if (!reporter) return { ok: false, reason: "You don't have a Player record — ask an admin to add you." };
  if (reporter.id === opponentPlayerId) {
    return { ok: false, reason: "Can't report against yourself." };
  }

  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true },
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
      reason: "There's already a pending Discord report for this match — confirm or dispute it in #results (or wait for the 2-min auto-confirm).",
    };
  }
  if (existing && existing.status === "DISPUTED") {
    return {
      ok: false,
      reason: "This match is disputed — a League Helper needs to resolve it before a new result can be recorded.",
    };
  }

  // Web reports finalize immediately — the reporter is signed in and
  // took a deliberate UI action, that's the commitment. Opponent gets
  // a DM with a dispute link if the result is wrong; the inline
  // dispute UI on /report routes through the helper-review flow.
  // The Discord /report slash command still uses the PENDING + 2-min
  // confirm window since that's natural in a channel context.
  const now = new Date();
  const reportedDeck = combo?.deck?.trim() || null;
  const reportedStake = combo?.stake?.trim() || null;
  const pairing = existing
    ? await prisma.pairing.update({
        where: { id: existing.id },
        data: {
          gamesWonA,
          gamesWonB,
          status: "CONFIRMED",
          reporterId: reporter.id,
          reportedAt: now,
          confirmedAt: now,
          reportedDeck,
          reportedStake,
        },
      })
    : await prisma.pairing.create({
        data: {
          divisionId: division.id,
          playerAId,
          playerBId,
          gamesWonA,
          gamesWonB,
          status: "CONFIRMED",
          reporterId: reporter.id,
          reportedAt: now,
          confirmedAt: now,
          reportedDeck,
          reportedStake,
        },
      });
  recomputeDivisionStandings(division.id).catch((err) =>
    console.warn("[web report] standings recompute failed:", err),
  );
  enqueueAnnounceResult(pairing.id).catch((err) =>
    console.warn("[web report] announce-result enqueue failed:", err),
  );

  // Opponent DM with dispute link. Best-effort — failures don't block
  // the report itself. Opponent can still see and dispute the match
  // on their /report page even if the DM never lands.
  const opponent = await prisma.player.findUnique({
    where: { id: opponentPlayerId },
    select: { discordId: true },
  });
  if (opponent?.discordId) {
    const reporterGames = reporterIsA ? gamesWonA : gamesWonB;
    const opponentGames = reporterIsA ? gamesWonB : gamesWonA;
    const siteUrl = (process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "") || "https://www.balatroleague.com";
    enqueueDm({
      discordId: opponent.discordId,
      content: buildOpponentReportDm({
        reporterDisplayName: reporter.displayName,
        reporterGames,
        opponentGames,
        divisionName: division.name,
        siteUrl,
      }),
    }).catch((err) => console.warn("[web report] opponent DM enqueue failed:", err));
  }

  return { ok: true, pairingId: pairing.id, created: !existing };
}

export type DisputeResultStr = "2-0" | "1-1" | "0-2" | "unsure";

export type DisputeOutcome =
  | { ok: true; pairingId: string }
  | { ok: false; reason: string };

// Web-side dispute action. Either player in the match can call. Allows
// PENDING or CONFIRMED to flip to DISPUTED with a proposed correction
// (or "unsure" for "let the helper figure it out"). Recomputes standings
// inline (cheap, single division) and enqueues the Discord thread spawn
// to the bot so the helper gets a ping.
export async function disputeMatchFromWeb(
  disputerDiscordId: string,
  pairingId: string,
  proposed: DisputeResultStr,
  reason: string | null,
): Promise<DisputeOutcome> {
  const player = await prisma.player.findUnique({ where: { discordId: disputerDiscordId } });
  if (!player) return { ok: false, reason: "You don't have a Player record." };

  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { division: { include: { season: true } } },
  });
  if (!pairing) return { ok: false, reason: "Match not found." };
  if (pairing.playerAId !== player.id && pairing.playerBId !== player.id) {
    return { ok: false, reason: "You're not part of this match." };
  }
  // Active season only — past seasons stay frozen.
  if (!pairing.division.season.isActive) {
    return {
      ok: false,
      reason: "Past seasons can't be disputed. Ask a League Helper if it's truly wrong.",
    };
  }
  if (pairing.status === "CANCELLED") {
    return { ok: false, reason: "This match was cancelled — nothing to dispute." };
  }

  let proposedGamesWonA: number | null = null;
  let proposedGamesWonB: number | null = null;
  if (proposed !== "unsure") {
    // Proposal is in disputer's POV. Translate to A/B coords.
    const disputerIsA = player.id === pairing.playerAId;
    const [self, opp] =
      proposed === "2-0" ? [2, 0] : proposed === "0-2" ? [0, 2] : [1, 1];
    proposedGamesWonA = disputerIsA ? self : opp;
    proposedGamesWonB = disputerIsA ? opp : self;
  }
  const cleanReason = reason?.trim().slice(0, 500) || null;

  await prisma.pairing.update({
    where: { id: pairingId },
    data: {
      status: "DISPUTED",
      disputedById: player.id,
      disputedAt: new Date(),
      disputeProposedGamesWonA: proposedGamesWonA,
      disputeProposedGamesWonB: proposedGamesWonB,
      disputeReason: cleanReason,
      // Clear so spawnDisputeThread acts even if a prior thread existed.
      disputeThreadId: null,
    },
  });
  await recomputeDivisionStandings(pairing.divisionId);
  enqueueDisputeSpawnThread(pairingId).catch((err) =>
    console.warn("[web dispute] thread spawn enqueue failed:", err),
  );

  return { ok: true, pairingId };
}
