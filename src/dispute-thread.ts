// Spawns the helper-mediation thread under a disputed pairing's report
// embed in #results. Two callers:
//   1. Discord button-driven dispute (match-buttons reportButtons) — calls
//      this AFTER updating the original embed via interaction.update
//   2. Web-side dispute action — enqueues a pg-boss job that calls this
//      headlessly (no interaction context)
//
// Idempotent: if Pairing.disputeThreadId is already set, no-op. Caller
// can call repeatedly without spawning duplicate threads.
//
// Best-effort: failures (deleted channel, lost embed, kicked bot) are
// logged but don't throw — the dispute itself is already recorded in the
// DB by the time we get here, so the worst case is "no Discord thread,
// helper resolves via /admin/disputes web UI."

import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type TextChannel,
} from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { buildReportEmbed } from "./report-flow.js";

export async function spawnDisputeThread(
  pairingId: string,
  // Skip the embed edit when the caller already did it via
  // interaction.update (Discord button path). Web path leaves this
  // false so the embed gets edited inside this function.
  opts: { skipEmbedEdit?: boolean } = {},
): Promise<void> {
  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: true, disputer: true },
  });
  if (!pairing) return;
  if (pairing.status !== "DISPUTED") return;
  if (pairing.disputeThreadId) return; // already spawned

  const client = tryGetDiscordClient();
  if (!client) {
    console.warn(`[dispute-thread] Discord client not ready for ${pairingId}`);
    return;
  }

  // Edit the original report embed to the DISPUTED state. If we don't
  // have a stored channel/message (rare — report was via Discord and
  // we never stashed), we still spawn the thread under whatever channel
  // we can find.
  const reporterIsA = pairing.reporterId === pairing.playerAId;
  const reporter = reporterIsA ? pairing.playerA : pairing.playerB;
  const opponent = reporterIsA ? pairing.playerB : pairing.playerA;

  let threadParent: TextChannel | null = null;
  let startMessageId: string | undefined;

  if (pairing.reportChannelId && pairing.reportMessageId) {
    try {
      const channel = await client.channels.fetch(pairing.reportChannelId);
      if (channel && channel.type === ChannelType.GuildText) {
        threadParent = channel as TextChannel;
        try {
          const message = await threadParent.messages.fetch(pairing.reportMessageId);
          startMessageId = message.id;
          if (!opts.skipEmbedEdit) {
            const embed = buildReportEmbed({
              status: "DISPUTED",
              reporter,
              opponent,
              divisionName: pairing.division.name,
              result: { gamesWonA: pairing.gamesWonA, gamesWonB: pairing.gamesWonB },
              reporterIsA,
              pairingId: pairing.id,
            });
            await message.edit({ content: "", embeds: [embed], components: [] });
          }
        } catch (err) {
          // Message gone but channel exists — spawn an unanchored thread
          // in the same channel instead of failing entirely.
          console.warn(`[dispute-thread] couldn't edit original embed:`, err);
        }
      }
    } catch (err) {
      console.warn(`[dispute-thread] couldn't fetch channel ${pairing.reportChannelId}:`, err);
    }
  }

  if (!threadParent) {
    console.warn(`[dispute-thread] no parent channel for ${pairingId}; helper will mediate via /admin/disputes`);
    return;
  }

  try {
    const thread = await threadParent.threads.create({
      name: `Dispute · ${reporter.displayName} vs ${opponent.displayName} · ${pairing.id.slice(-6)}`,
      type: ChannelType.PublicThread,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      // startMessage anchors the thread to the report embed if we have it;
      // otherwise it spawns standalone in the channel.
      startMessage: startMessageId,
    });

    const staffBindings = await prisma.roleBinding.findMany({
      where: { tier: { in: ["ADMIN", "HELPER"] } },
    });
    const staffMentions = staffBindings.map((b) => `<@&${b.discordRoleId}>`).join(" ");

    // If the disputer proposed a correction, surface it prominently —
    // that's the one-click signal for the helper.
    let proposalLine = "";
    if (
      pairing.disputeProposedGamesWonA != null &&
      pairing.disputeProposedGamesWonB != null
    ) {
      proposalLine =
        `\n\n**Proposed correction:** ${pairing.playerA.displayName} ` +
        `**${pairing.disputeProposedGamesWonA}-${pairing.disputeProposedGamesWonB}** ` +
        `${pairing.playerB.displayName}` +
        `\n_Helper can one-click accept this from <https://www.balatroleague.com/admin/disputes>._`;
    }
    const reasonLine = pairing.disputeReason
      ? `\n\n**Reason:** ${pairing.disputeReason}`
      : "";
    const disputerLine = pairing.disputer
      ? `<@${pairing.disputer.discordId}> disputed the result.`
      : `The result was disputed.`;

    await thread.send({
      content:
        `${staffMentions ? staffMentions + "\n" : ""}` +
        `<@${reporter.discordId}> reported **${reporter.displayName} ${pairing.gamesWonA}-${pairing.gamesWonB} ${opponent.displayName}** in **${pairing.division.name}**.\n` +
        disputerLine +
        proposalLine +
        reasonLine +
        `\n\nDiscuss what happened here. A helper will jump in to fix the result or roll it back to unplayed.`,
    });

    await prisma.pairing.update({
      where: { id: pairing.id },
      data: { disputeThreadId: thread.id },
    });
  } catch (err) {
    console.warn(`[dispute-thread] thread spawn failed for ${pairingId}:`, err);
  }
}
