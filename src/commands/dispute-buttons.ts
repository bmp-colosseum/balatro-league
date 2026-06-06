// In-thread dispute resolution buttons (posted on the dispute thread by
// spawnDisputeThread). Two actions:
//   close  — end the dispute, KEEP the reported result. Either player can
//            do this ("never mind, the score stands"), as can staff.
//   apply  — resolve by applying the disputer's PROPOSED correction.
//            Staff (HELPER/ADMIN) only; shown only when a proposal exists.
// Both flip the Pairing back to CONFIRMED, recompute + announce, and delete
// the dispute thread.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  type ButtonInteraction,
  type GuildMember,
} from "discord.js";
import { recordAudit, actorFromInteractionUser } from "../audit.js";
import { prisma } from "../db.js";
import { hasTier } from "../permissions.js";
import { enqueueAnnounceResult } from "../queue.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
import type { ButtonHandler } from "./types.js";

// Action row for the dispute thread message. "Apply proposed" only shows
// when the disputer actually proposed a corrected score.
export function disputeThreadButtons(
  pairingId: string,
  hasProposal: boolean,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dispute-thread:close:${pairingId}`)
      .setLabel("Close — keep reported result")
      .setStyle(ButtonStyle.Secondary),
  );
  if (hasProposal) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`dispute-thread:apply:${pairingId}`)
        .setLabel("Apply proposed result (staff)")
        .setStyle(ButtonStyle.Primary),
    );
  }
  return row;
}

async function resolveDispute(
  interaction: ButtonInteraction,
  pairingId: string,
  mode: "close" | "apply",
): Promise<{ ok: true; gamesWonA: number; gamesWonB: number } | { ok: false; reason: string }> {
  const pairing = await prisma.pairing.findUnique({ where: { id: pairingId } });
  if (!pairing) return { ok: false, reason: "This match isn't on record anymore." };
  if (pairing.status !== "DISPUTED") return { ok: false, reason: "This match isn't disputed anymore." };

  let gamesWonA = pairing.gamesWonA;
  let gamesWonB = pairing.gamesWonB;
  if (mode === "apply") {
    if (pairing.disputeProposedGamesWonA == null || pairing.disputeProposedGamesWonB == null) {
      return { ok: false, reason: "There's no proposed result to apply." };
    }
    gamesWonA = pairing.disputeProposedGamesWonA;
    gamesWonB = pairing.disputeProposedGamesWonB;
  }

  await prisma.pairing.update({
    where: { id: pairingId },
    data: {
      status: "CONFIRMED",
      gamesWonA,
      gamesWonB,
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason:
        mode === "apply" ? "Dispute resolved — proposed result applied" : "Dispute closed — reported result kept",
      // Clear the in-flight proposal; keep disputedAt/disputedById as audit.
      disputeProposedGamesWonA: null,
      disputeProposedGamesWonB: null,
    },
  });
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  enqueueAnnounceResult(pairingId).catch(() => {});
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: mode === "apply" ? "dispute.resolve-apply" : "dispute.close",
    targetType: "Pairing",
    targetId: pairingId,
    summary:
      mode === "apply"
        ? `Resolved dispute on ${pairingId.slice(-6)} — applied ${gamesWonA}-${gamesWonB}`
        : `Closed dispute on ${pairingId.slice(-6)} — kept ${gamesWonA}-${gamesWonB}`,
    metadata: { pairingId, mode, gamesWonA, gamesWonB, divisionId: pairing.divisionId },
  });

  // Delete the dispute thread — it's resolved.
  if (pairing.disputeThreadId) {
    try {
      const channel = await interaction.client.channels.fetch(pairing.disputeThreadId);
      if (
        channel &&
        (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread)
      ) {
        await channel.delete("Dispute resolved").catch(() => {});
      }
    } catch {
      // best-effort
    }
  }
  return { ok: true, gamesWonA, gamesWonB };
}

export const disputeThreadButtonHandler: ButtonHandler = {
  prefix: "dispute-thread:",
  async execute(interaction: ButtonInteraction) {
    const [, action, pairingId] = interaction.customId.split(":");
    if (!pairingId || (action !== "close" && action !== "apply")) {
      await interaction.reply({ content: "This button looks broken — refresh Discord.", flags: MessageFlags.Ephemeral });
      return;
    }

    const pairing = await prisma.pairing.findUnique({
      where: { id: pairingId },
      include: { playerA: { select: { discordId: true } }, playerB: { select: { discordId: true } } },
    });
    if (!pairing) {
      await interaction.reply({ content: "This match isn't on record anymore.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
    const isStaff = await hasTier(member, interaction.user.id, "HELPER");
    const isPlayer =
      interaction.user.id === pairing.playerA.discordId || interaction.user.id === pairing.playerB.discordId;

    if (action === "apply" && !isStaff) {
      await interaction.reply({ content: "Only a League Helper or Admin can apply a corrected result.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "close" && !isPlayer && !isStaff) {
      await interaction.reply({ content: "Only the two players or a helper can close this dispute.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Ack before the thread is deleted in resolveDispute.
    await interaction.reply({
      content: action === "apply" ? "Applying the proposed result…" : "Closing the dispute…",
      flags: MessageFlags.Ephemeral,
    });
    const r = await resolveDispute(interaction, pairingId, action);
    if (!r.ok) {
      await interaction.followUp({ content: r.reason, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    await interaction
      .followUp({
        content: `✓ Dispute ${action === "apply" ? "resolved" : "closed"} — recorded **${r.gamesWonA}-${r.gamesWonB}**.`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  },
};
