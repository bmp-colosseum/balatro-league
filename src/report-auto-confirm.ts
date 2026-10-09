// Auto-confirm a PENDING pairing after the 2-min grace window. Called
// by the pg-boss 'report.auto-confirm' worker. No-op if the pairing
// already left PENDING — admin overrode it, opponent confirmed, opponent
// disputed, etc. Idempotent so retries are safe.

import { ChannelType, MessageFlags, type TextChannel } from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { enqueueAnnounceResult, maybeEnqueueShootoutCheck } from "./queue.js";
import { buildReportContainer } from "./report-flow.js";
import { recomputeDivisionStandings } from "./standings-cache.js";

export async function autoConfirmReport(pairingId: string): Promise<void> {
  const pairing = await prisma.match.findUnique({
    where: { id: pairingId },
    include: {
      playerA: true,
      playerB: true,
      division: true,
    },
  });
  if (!pairing) return;
  if (pairing.status !== "PENDING") return;

  // Persist winnerId from the score (the report path doesn't set it) so every
  // confirmed match carries a winner — derived from gamesWon, draw → null.
  const winnerId =
    pairing.gamesWonA > pairing.gamesWonB ? pairing.playerAId
      : pairing.gamesWonB > pairing.gamesWonA ? pairing.playerBId
      : null;
  await prisma.match.update({
    where: { id: pairingId },
    data: { status: "CONFIRMED", confirmedAt: new Date(), winnerId },
  });
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  enqueueAnnounceResult(pairingId).catch(() => {});
  // Division may have just completed → check for boundary-tie shootouts.
  maybeEnqueueShootoutCheck(pairing.divisionId).catch(() => {});

  // Edit the original embed to reflect the auto-confirm so players
  // see the outcome inline. Drop the buttons; the match is settled.
  if (pairing.reportChannelId && pairing.reportMessageId) {
    const client = tryGetDiscordClient();
    if (!client) return;
    try {
      const channel = await client.channels.fetch(pairing.reportChannelId);
      if (!channel || channel.type !== ChannelType.GuildText) return;
      const message = await (channel as TextChannel).messages.fetch(pairing.reportMessageId);
      const reporterIsA = pairing.reporterId === pairing.playerAId;
      const reporter = reporterIsA ? pairing.playerA : pairing.playerB;
      const opponent = reporterIsA ? pairing.playerB : pairing.playerA;
      const container = buildReportContainer({
        status: "AUTO_CONFIRMED",
        reporter,
        opponent,
        divisionName: pairing.division.name,
        result: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
        reporterIsA,
        pairingId: pairing.id,
      });
      await message.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
    } catch (err) {
      console.warn(`[report.auto-confirm] couldn't edit embed for ${pairingId}:`, err);
    }
  }
}
