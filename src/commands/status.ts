import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { formatSeasonLabel } from "../format-season.js";
import { computeStandings } from "../standings.js";
import type { SlashCommand } from "./types.js";

// /status — "where do I stand right now": your division, rank, points, record.
// The standing half of the picture; /schedule is the matches half.
export const status: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Where you stand this season — your division, rank, points, and record."),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const me = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));
    const activeSeason = await activePublicSeason();
    if (!activeSeason) {
      await interaction.editReply("No active season right now.");
      return;
    }

    const membership = await prisma.divisionMember.findFirst({
      where: { playerId: me.id, status: "ACTIVE", division: { seasonId: activeSeason.id } },
      include: {
        division: {
          include: {
            tier: true,
            members: { where: { status: "ACTIVE" }, include: { player: true } },
            matches: {
              where: { format: "LEAGUE_BO2", status: "CONFIRMED" },
              select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
            },
          },
        },
      },
    });
    if (!membership) {
      await interaction.editReply("You're not in a division this season. Once you're placed, `/schedule` shows your matches.");
      return;
    }

    const div = membership.division;
    const rows = computeStandings(div.members.map((m) => m.player), div.matches);
    const myRow = rows.find((r) => r.player.id === me.id);
    if (!myRow) {
      await interaction.editReply(`You're in **${div.name}**, but no standings row yet — play a match and it'll show up.`);
      return;
    }
    const rank = myRow.rank ?? rows.findIndex((r) => r.player.id === me.id) + 1;

    const embed = new EmbedBuilder()
      .setTitle(`Your status — ${div.name}`)
      .setColor(0x5865f2)
      .setDescription(
        `**${formatSeasonLabel(activeSeason)}** · ${div.tier.name} tier\n\n` +
          `🏅 **#${rank}** of ${rows.length}\n` +
          `**${myRow.points}** pts · ${myRow.wins}W · ${myRow.draws}D · ${myRow.losses}L  _(${myRow.played} played)_\n\n` +
          `Run \`/schedule\` for your remaining matches.`,
      );
    await interaction.editReply({ embeds: [embed] });
  },
};
