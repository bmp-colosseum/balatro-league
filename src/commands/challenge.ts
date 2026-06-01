// /challenge — same ban/pick flow as /start-match but NOT a league match.
// No division or season required, no Pairing written, no announce. Best-of
// is configurable (1, 2, or 3).

import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { prisma } from "../db.js";
import { getLeagueSettings } from "../league-settings.js";
import { renderMatch } from "../match-render.js";
import { getOrCreatePlayer } from "../players.js";
import type { SlashCommand } from "./types.js";

const BO_CHOICES = [
  { name: "Best of 1", value: 1 },
  { name: "Best of 2", value: 2 },
  { name: "Best of 3", value: 3 },
] as const;

export const challenge: SlashCommand = {
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("challenge")
    .setDescription("Casual best-of-N match against another player (not recorded to the league).")
    .addUserOption((opt) =>
      opt.setName("opponent").setDescription("The player you're challenging").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("best-of")
        .setDescription("Number of games")
        .setRequired(false)
        .addChoices(...BO_CHOICES),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const opponentUser = interaction.options.getUser("opponent", true);
    const bestOf = (interaction.options.getInteger("best-of") ?? 2) as 1 | 2 | 3;

    if (opponentUser.id === interaction.user.id) {
      await interaction.reply({ content: "Can't challenge yourself.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (opponentUser.bot) {
      await interaction.reply({ content: "Opponents must be real players, not bots.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Run this in a regular text channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();

    const me = await getOrCreatePlayer(interaction.user);
    const opp = await getOrCreatePlayer(opponentUser);

    // Refuse if there's an in-flight session between them (league OR casual)
    const inFlight = await prisma.matchSession.findFirst({
      where: {
        OR: [
          { playerAId: me.id, playerBId: opp.id },
          { playerAId: opp.id, playerBId: me.id },
        ],
        state: { notIn: ["COMPLETE", "CANCELLED"] },
      },
    });
    if (inFlight) {
      await interaction.editReply(
        `There's already an active match between you two (${inFlight.id}). Finish it or have an admin cancel it before starting another.`,
      );
      return;
    }

    // Casual session — no division, no season.
    const settings = await getLeagueSettings();
    const expiresAt = new Date(Date.now() + settings.matchInviteExpiryMinutes * 60 * 1000);
    const session = await prisma.matchSession.create({
      data: {
        playerAId: me.id,
        playerBId: opp.id,
        state: "WAITING_ACCEPT",
        channelId: interaction.channelId,
        isCasual: true,
        bestOf,
        expiresAt,
      },
    });

    const { embeds, components } = renderMatch(session, me, opp);
    const message = await (interaction.channel as TextChannel).send({ embeds, components });
    await interaction.editReply(`Challenge posted (Best of ${bestOf}): ${message.url}`);
  },
};
