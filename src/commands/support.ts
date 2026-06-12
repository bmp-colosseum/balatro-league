// /support — open a private support ticket. Creates a private thread in the
// configured support channel, adds the requester, and pings the league's
// helper role(s) (reusing the same summon logic as /helper). The support
// channel is set per-server on /admin/config, so this works in any server
// without bootstrapping.

import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { prisma } from "../db.js";
import { getConfig, LeagueConfigKey } from "../league-config.js";
import { logDiscordError } from "../log-discord-error.js";
import { supportTicketButtons, supportTicketEmbed } from "../support-ticket.js";
import { summonHelpers } from "./helper.js";
import type { SlashCommand } from "./types.js";

export const support: SlashCommand = {
  // Opens a ticket thread + pings helpers — keep it in the bot-commands
  // channel(s) (threads under them are allowed too via the scope check).
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("support")
    .setDescription("Open a private support ticket — a league helper will be pinged.")
    .addStringOption((opt) =>
      opt
        .setName("issue")
        .setDescription("What do you need help with?")
        .setRequired(true)
        .setMaxLength(500),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "Run this in the server, not DMs.", flags: MessageFlags.Ephemeral });
      return;
    }
    const issue = interaction.options.getString("issue", true).trim();

    const supportChannelId = await getConfig(LeagueConfigKey.SupportChannelId);
    if (!supportChannelId) {
      await interaction.reply({
        content:
          "No support channel is set up yet. Ask an admin to configure one on the Config page (Community channels → Support channel ID).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await interaction.client.channels.fetch(supportChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply(
        "The configured support channel is missing or isn't a normal text channel — ask an admin to fix it on /admin/config.",
      );
      return;
    }

    // Create the tracked ticket first so it has a stable id (used in the
    // thread name + embed); fill threadId in once the thread exists.
    const ticket = await prisma.supportTicket.create({
      data: {
        guildId: interaction.guild.id,
        channelId: supportChannelId,
        threadId: "pending",
        requesterId: interaction.user.id,
        requesterName: interaction.user.username,
        issue,
      },
    });

    let thread;
    try {
      thread = await (channel as TextChannel).threads.create({
        name: `ticket-${ticket.id.slice(-6)}-${interaction.user.username}`.slice(0, 90),
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      await thread.members.add(interaction.user.id).catch(() => {});
    } catch (err) {
      logDiscordError("support.create-thread", err, { channelId: supportChannelId, userId: interaction.user.id });
      await prisma.supportTicket.delete({ where: { id: ticket.id } }).catch(() => {});
      await interaction.editReply(
        "Couldn't open a ticket thread — the bot may be missing permission to create private threads in the support channel.",
      );
      return;
    }

    const saved = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { threadId: thread.id },
    });

    await thread
      .send({ embeds: [supportTicketEmbed(saved)], components: [supportTicketButtons(saved.id)] })
      .catch(() => {});

    // Ping + pull in the helper role(s). If none is configured, the ticket
    // still exists — just leave a note so an admin can wire it up.
    const summoned = await summonHelpers({
      guild: interaction.guild,
      channel: thread,
      caller: interaction.user,
      reason: issue,
    });
    if ("content" in summoned) {
      await thread.send(summoned.content).catch(() => {});
    } else {
      await thread.send(`⚠️ ${summoned.error}`).catch(() => {});
    }

    await interaction.editReply(`🎫 Opened ticket **#${saved.id.slice(-6)}**: ${thread.toString()}`);
  },
};
