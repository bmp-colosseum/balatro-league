// In-thread dispute resolution (posted on the dispute thread by
// spawnDisputeThread). Actions:
//   close  — end the dispute, KEEP the reported result. Either player can
//            do this ("never mind, the score stands"), as can staff.
//   apply  — resolve by applying the disputer's PROPOSED correction.
//            Staff (HELPER/ADMIN) only; shown only when a proposal exists.
//   other  — staff pick a DIFFERENT result entirely (when neither the
//            reported nor proposed score is right). Opens a result picker.
// All resolve the Pairing to CONFIRMED, recompute + announce, delete the
// dispute thread, and clear the in-flight proposal.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type GuildMember,
  type StringSelectMenuInteraction,
} from "discord.js";
import { recordAudit, actorFromInteractionUser } from "../audit.js";
import { prisma } from "../db.js";
import { hasTier } from "../permissions.js";
import { enqueueAnnounceResult } from "../queue.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
import type { ButtonHandler, SelectMenuHandler } from "./types.js";

// Action row for the dispute thread message. "Apply proposed" shows only
// when the disputer proposed a corrected score; "Set other result" is
// always available for staff.
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
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`dispute-thread:other:${pairingId}`)
      .setLabel("Set other result (staff)")
      .setStyle(ButtonStyle.Secondary),
  );
  return row;
}

function isStaffMember(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<boolean> {
  const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
  return hasTier(member, interaction.user.id, "HELPER");
}

// Core resolution: write the result, clear the proposal, recompute,
// announce, audit, delete the dispute thread. Returns ok/reason. Loads
// the pairing fresh so a stale button can't double-resolve.
async function applyResolution(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  pairingId: string,
  gamesWonA: number,
  gamesWonB: number,
  actionTag: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pairing = await prisma.match.findUnique({ where: { id: pairingId } });
  if (!pairing) return { ok: false, reason: "This match isn't on record anymore." };
  if (pairing.status !== "DISPUTED") return { ok: false, reason: "This match isn't disputed anymore." };

  const winnerId = gamesWonA > gamesWonB ? pairing.playerAId : gamesWonB > gamesWonA ? pairing.playerBId : null;
  await prisma.match.update({
    where: { id: pairingId },
    data: {
      status: "CONFIRMED",
      gamesWonA,
      gamesWonB,
      winnerId,
      confirmedAt: new Date(),
      adminOverrideBy: interaction.user.id,
      adminOverrideReason: reason,
      disputeProposedGamesWonA: null,
      disputeProposedGamesWonB: null,
    },
  });
  recomputeDivisionStandings(pairing.divisionId).catch(() => {});
  enqueueAnnounceResult(pairingId).catch(() => {});
  recordAudit({
    actor: actorFromInteractionUser(interaction.user),
    action: actionTag,
    targetType: "Pairing",
    targetId: pairingId,
    summary: `${reason} — ${pairing.playerAId.slice(-4)} ${gamesWonA}-${gamesWonB} ${pairing.playerBId.slice(-4)}`,
    metadata: { pairingId, gamesWonA, gamesWonB, divisionId: pairing.divisionId },
  });
  if (pairing.disputeThreadId) {
    try {
      const channel = await interaction.client.channels.fetch(pairing.disputeThreadId);
      if (channel && (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread)) {
        await channel.delete("Dispute resolved").catch(() => {});
      }
    } catch {
      // best-effort
    }
  }
  return { ok: true };
}

export const disputeThreadButtonHandler: ButtonHandler = {
  prefix: "dispute-thread:",
  async execute(interaction: ButtonInteraction) {
    const [, action, pairingId] = interaction.customId.split(":");
    if (!pairingId || (action !== "close" && action !== "apply" && action !== "other")) {
      await interaction.reply({ content: "This button looks broken — refresh Discord.", flags: MessageFlags.Ephemeral });
      return;
    }

    const pairing = await prisma.match.findUnique({
      where: { id: pairingId },
      include: {
        playerA: { select: { discordId: true, displayName: true } },
        playerB: { select: { discordId: true, displayName: true } },
      },
    });
    if (!pairing) {
      await interaction.reply({ content: "This match isn't on record anymore.", flags: MessageFlags.Ephemeral });
      return;
    }
    const staff = await isStaffMember(interaction);
    const isPlayer =
      interaction.user.id === pairing.playerA.discordId || interaction.user.id === pairing.playerB.discordId;

    if ((action === "apply" || action === "other") && !staff) {
      await interaction.reply({ content: "Only a League Helper or Admin can set a corrected result.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "close" && !isPlayer && !staff) {
      await interaction.reply({ content: "Only the two players or a helper can close this dispute.", flags: MessageFlags.Ephemeral });
      return;
    }

    // "other" → show the result picker (ephemeral) and stop here.
    if (action === "other") {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`dispute-resolve-select:${pairingId}`)
        .setPlaceholder("Set the correct result")
        .addOptions(
          { label: `${pairing.playerA.displayName} won 2-0`, value: "2-0" },
          { label: "Draw 1-1", value: "1-1" },
          { label: `${pairing.playerB.displayName} won 2-0`, value: "0-2" },
        );
      await interaction.reply({
        content: "Pick the correct result — applies it and closes the dispute.",
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const keep = action === "close";
    if (!keep && (pairing.disputeProposedGamesWonA == null || pairing.disputeProposedGamesWonB == null)) {
      await interaction.reply({ content: "There's no proposed result to apply — use Set other result.", flags: MessageFlags.Ephemeral });
      return;
    }
    const gamesWonA = keep ? pairing.gamesWonA : pairing.disputeProposedGamesWonA!;
    const gamesWonB = keep ? pairing.gamesWonB : pairing.disputeProposedGamesWonB!;

    await interaction.reply({
      content: keep ? "Closing the dispute…" : "Applying the proposed result…",
      flags: MessageFlags.Ephemeral,
    });
    const r = await applyResolution(
      interaction,
      pairingId,
      gamesWonA,
      gamesWonB,
      keep ? "dispute.close" : "dispute.resolve-apply",
      keep ? "Dispute closed — reported result kept" : "Dispute resolved — proposed result applied",
    );
    await interaction
      .followUp({
        content: r.ok ? `✓ Dispute resolved — recorded **${gamesWonA}-${gamesWonB}**.` : r.reason,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  },
};

// Staff picked a custom result from the "Set other result" menu.
export const disputeResolveSelect: SelectMenuHandler = {
  prefix: "dispute-resolve-select:",
  async execute(interaction: StringSelectMenuInteraction) {
    const pairingId = interaction.customId.split(":")[1];
    if (!pairingId) {
      await interaction.reply({ content: "This menu looks broken — refresh Discord.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await isStaffMember(interaction))) {
      await interaction.reply({ content: "Only a League Helper or Admin can set a result.", flags: MessageFlags.Ephemeral });
      return;
    }
    const choice = interaction.values[0];
    const map: Record<string, [number, number]> = { "2-0": [2, 0], "1-1": [1, 1], "0-2": [0, 2] };
    const pair = choice ? map[choice] : undefined;
    if (!pair) {
      await interaction.reply({ content: "Unknown result.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update({ content: "Applying…", components: [] });
    const r = await applyResolution(
      interaction,
      pairingId,
      pair[0],
      pair[1],
      "dispute.resolve-custom",
      "Dispute resolved — staff set a corrected result",
    );
    await interaction
      .followUp({
        content: r.ok ? `✓ Dispute resolved — recorded **${pair[0]}-${pair[1]}**.` : r.reason,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  },
};
