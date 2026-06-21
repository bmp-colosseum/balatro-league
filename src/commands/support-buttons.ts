// Close button on a /support ticket. The requester OR any staff member
// (HELPER tier and up) can close it: marks the row CLOSED, re-renders the
// embed, drops the button, and locks + archives the thread.

import {
  ChannelType,
  MessageFlags,
  type ButtonInteraction,
  type GuildMember,
  type ThreadChannel,
} from "discord.js";
import { prisma } from "../db.js";
import { hasTier } from "../permissions.js";
import { supportTicketEmbed } from "../support-ticket.js";
import type { ButtonHandler } from "./types.js";

export const supportButtons: ButtonHandler = {
  prefix: "support:",
  async execute(interaction: ButtonInteraction) {
    const [, action, ticketId] = interaction.customId.split(":");
    if (action !== "close" || !ticketId) {
      await interaction.reply({ content: "This button looks broken — refresh Discord and try again.", flags: MessageFlags.Ephemeral });
      return;
    }

    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      await interaction.reply({ content: "That ticket isn't on record anymore.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (ticket.status === "CLOSED") {
      await interaction.reply({ content: "This ticket is already closed.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
    const isRequester = ticket.requesterId === interaction.user.id;
    const isStaff = await hasTier(member, interaction.user.id, "HELPER");
    if (!isRequester && !isStaff) {
      await interaction.reply({
        content: "Only the person who opened this ticket or a league helper can close it.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const closed = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: "CLOSED", closedById: interaction.user.id, closedAt: new Date() },
    });

    // Re-render the embed as closed + drop the Close button.
    await interaction.update({ embeds: [supportTicketEmbed(closed)], components: [] }).catch(() => {});

    // Note it, then lock + archive the thread (send before archiving — an
    // archived thread can't receive new messages).
    const ch = interaction.channel;
    if (ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread)) {
      const thread = ch as ThreadChannel;
      await thread.send(`🔒 Ticket closed by <@${interaction.user.id}>.`).catch(() => {});
      await thread.setLocked(true).catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }
  },
};
