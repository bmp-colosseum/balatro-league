// Pure web-side report logic. Mirrors src/reporting.ts so the rules
// (one pending-then-confirmed Pairing per matchup per season,
// validates both players in same division) are identical no matter
// where the report comes from.

import { prisma } from "@/lib/prisma";
import { enqueueAnnounceResult, enqueueDm } from "@/lib/queue";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { recordAudit } from "@/lib/audit";

// Compose the DM body sent to the opponent when a web-side report
// confirms a match. Phrased from the opponent's POV so they don't have
// to flip the score in their head. The match also posts to #results with
// a "Report a problem" button, so that's the pointer given here rather
// than a web dispute flow (there isn't one — a wrong result goes through
// that button or a support ticket, and staff fix it on the admin side).
function buildOpponentReportDm(args: {
  reporterDisplayName: string;
  reporterGames: number;
  opponentGames: number;
  divisionName: string;
  siteUrl: string;
}): string {
  const { reporterDisplayName, reporterGames, opponentGames, divisionName } = args;
  const verdict =
    reporterGames > opponentGames
      ? `**${reporterDisplayName}** reported a **${reporterGames}-${opponentGames}** win over you in ${divisionName}.`
      : reporterGames < opponentGames
        ? `**${reporterDisplayName}** reported a **${reporterGames}-${opponentGames}** loss to you in ${divisionName}.`
        : `**${reporterDisplayName}** reported a **1-1 draw** against you in ${divisionName}.`;
  return (
    `📝 ${verdict}\n\n` +
    `It's already recorded in standings. **Something wrong?** Press **Report a problem** on the result post in #results (or open a ticket with /support).`
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

// Per-game detail a player can report. Decks/stakes differ per game in a BO2,
// so each game carries its own combo (plus the winner's leftover lives).
export interface ReportGameInput {
  deck?: string | null;
  stake?: string | null;
  lives?: number | null;
}

export async function reportSetFromWeb(
  reporterDiscordId: string,
  opponentPlayerId: string,
  result: ReportResultStr,
  games?: { game1?: ReportGameInput; game2?: ReportGameInput },
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
  const score = gamesFromResult(result);
  const gamesWonA = reporterIsA ? score.a : score.b;
  const gamesWonB = reporterIsA ? score.b : score.a;

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
  // A pre-created (locked-schedule) match is PENDING with no reporter yet — that's
  // an UNPLAYED assigned matchup, not a pending report, so let it finalize below.
  // A PENDING row WITH a reporter is a real Discord report awaiting confirmation.
  if (existing && existing.status === "PENDING" && existing.reporterId) {
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

  // Schedule enforcement: when the season is schedule-locked, the only valid
  // matchups are the pre-created ones. No row for this pair means it isn't on the
  // schedule — reject (you only play your assigned opponents). With no locked
  // schedule (legacy on-demand round-robin) any same-division pair is allowed.
  if (!existing && activeSeason.scheduleLocked) {
    return {
      ok: false,
      reason: "That opponent isn't on your schedule this season — you only play your assigned matchups.",
    };
  }

  // Web reports finalize immediately — the reporter is signed in and
  // took a deliberate UI action, that's the commitment. Opponent gets
  // a DM with a dispute link if the result is wrong; the inline
  // dispute UI on /report routes through the helper-review flow.
  // The Discord /report slash command still uses the PENDING + 2-min
  // confirm window since that's natural in a channel context.
  const now = new Date();
  // Per-game combos (decks/stakes differ per game). The Match keeps a single
  // "headline" reportedDeck/Stake = game 1's, for list views that show one combo;
  // the full per-game detail lives on the Game rows written below.
  const g1 = games?.game1 ?? {};
  const g2 = games?.game2 ?? {};
  const deck1 = g1.deck?.trim() || null;
  const stake1 = g1.stake?.trim() || null;
  const deck2 = g2.deck?.trim() || null;
  const stake2 = g2.stake?.trim() || null;
  const reportedDeck = deck1;
  const reportedStake = stake1;
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
  // Capture the per-game detail (deck, stake, and the winner's leftover lives)
  // so the record matches reality — decks differ per game — and the standings
  // life-differential tiebreaker has data. Each game's winner is derived from
  // the result: a 2-0/0-2 has one player winning both; a 1-1 splits — slot 1 is
  // the reporter's win, slot 2 the opponent's (order is irrelevant to the
  // differential). firstPlayerId is unknown for a manual report and set to A for
  // a stable value (only meaningful for games with a GameDeck ban pool, which
  // these don't have). Write the rows whenever ANY per-game detail was given.
  const livesG1 = parseLives(g1.lives);
  const livesG2 = parseLives(g2.lives);
  const hasGameDetail =
    livesG1 !== null || livesG2 !== null || !!deck1 || !!stake1 || !!deck2 || !!stake2;
  if (hasGameDetail) {
    const [w1, w2] =
      result === "2-0" ? [reporter.id, reporter.id]
        : result === "0-2" ? [opponentPlayerId, opponentPlayerId]
        : [reporter.id, opponentPlayerId]; // 1-1: reporter's win, then opponent's
    // Replace any prior rows so a re-record stays consistent.
    await prisma.game.deleteMany({ where: { matchId: pairing.id } });
    await prisma.game.createMany({
      data: [
        { matchId: pairing.id, num: 1, firstPlayerId: playerAId, winnerId: w1, winnerLives: livesG1, deck: deck1, stake: stake1 },
        { matchId: pairing.id, num: 2, firstPlayerId: playerAId, winnerId: w2, winnerLives: livesG2, deck: deck2, stake: stake2 },
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
    metadata: { result, deck1, stake1, deck2, stake2, livesG1, livesG2, divisionId: division.id, opponentPlayerId },
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

// There's no web-side dispute action anymore — a wrong result goes through
// the "Report a problem" button on the #results post (src/announce.ts),
// or a /support ticket. Staff fix it on /admin/matches. The admin
// accept/reject tooling for matches that are ALREADY DISPUTED (legacy rows)
// still lives in web/lib/bulk-resolve.ts and web/app/admin/matches.
