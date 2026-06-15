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
import { recordAudit } from "@/lib/audit";

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

// Parse a manual "winner's lives left" input into a non-negative integer.
// Blank / non-integer / out-of-range → null (not captured).
function parseLives(v: number | null | undefined): number | null {
  if (v == null || !Number.isInteger(v) || v < 0 || v > 999) return null;
  return v;
}

export type ReportOutcome =
  | { ok: true; pairingId: string; created: boolean }
  | { ok: false; reason: string };

export async function reportSetFromWeb(
  reporterDiscordId: string,
  opponentPlayerId: string,
  result: ReportResultStr,
  combo?: { deck?: string | null; stake?: string | null },
  lives?: { game1?: number | null; game2?: number | null },
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
  const winnerId = gamesWonA > gamesWonB ? playerAId : gamesWonB > gamesWonA ? playerBId : null;
  const pairing = existing
    ? await prisma.match.update({
        where: { id: existing.id },
        data: {
          gamesWonA,
          gamesWonB,
          winnerId,
          status: "CONFIRMED",
          reporterId: reporter.id,
          reportedAt: now,
          confirmedAt: now,
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
          winnerId,
          status: "CONFIRMED",
          reporterId: reporter.id,
          reportedAt: now,
          confirmedAt: now,
          reportedDeck,
          reportedStake,
        },
      });
  // Capture the winner's lives per game so the standings life-differential
  // tiebreaker has data and players don't do the math by hand. Each game's
  // winner is derived from the result: a 2-0/0-2 has one player winning both;
  // a 1-1 splits — slot 1 is the reporter's win, slot 2 the opponent's (order
  // is irrelevant to the differential). A manual report doesn't know the
  // per-game deck/stake (the headline combo lives on the Match as
  // reportedDeck/Stake), so those stay null; firstPlayerId is unknown too and
  // set to A for a stable value (only consumed for games with a GameDeck pool,
  // which these don't).
  const livesG1 = parseLives(lives?.game1);
  const livesG2 = parseLives(lives?.game2);
  if (livesG1 !== null || livesG2 !== null) {
    const [w1, w2] =
      result === "2-0" ? [reporter.id, reporter.id]
        : result === "0-2" ? [opponentPlayerId, opponentPlayerId]
        : [reporter.id, opponentPlayerId]; // 1-1: reporter's win, then opponent's
    // Replace any prior rows so a re-record stays consistent.
    await prisma.game.deleteMany({ where: { matchId: pairing.id } });
    await prisma.game.createMany({
      data: [
        { matchId: pairing.id, num: 1, firstPlayerId: playerAId, winnerId: w1, winnerLives: livesG1 },
        { matchId: pairing.id, num: 2, firstPlayerId: playerAId, winnerId: w2, winnerLives: livesG2 },
      ],
    });
  }

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
    select: { discordId: true, displayName: true },
  });

  // Audit the player-reported result (the bot already audits Discord reports;
  // this covers web reports). Actor = the reporting player, not an admin.
  await recordAudit({
    actor: { discordId: reporter.discordId, displayName: reporter.displayName },
    action: "match.report.web",
    targetType: "Match",
    targetId: pairing.id,
    summary: `${reporter.displayName} reported ${result} vs ${opponent?.displayName ?? "opponent"} (${division.name})`,
    metadata: { result, deck: reportedDeck, stake: reportedStake, livesG1, livesG2, divisionId: division.id, opponentPlayerId },
  }).catch(() => { /* audit must never block a report */ });
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

  const pairing = await prisma.match.findUnique({
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

  await prisma.match.update({
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

  await recordAudit({
    actor: { discordId: player.discordId, displayName: player.displayName },
    action: "match.dispute.web",
    targetType: "Match",
    targetId: pairingId,
    summary: `${player.displayName} disputed a match (proposed ${proposed})${cleanReason ? ` — ${cleanReason}` : ""}`,
    metadata: { proposed, reason: cleanReason, divisionId: pairing.divisionId },
  }).catch(() => { /* audit must never block a dispute */ });

  return { ok: true, pairingId };
}
