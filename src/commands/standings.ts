import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { computeStandings, formatDivisionField, formatStandingsTable } from "../standings.js";
import { tierEmbedColor } from "../tiers.js";
import { divisionNameAutocomplete } from "./autocomplete.js";
import type { SlashCommand } from "./types.js";

export const standings: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("standings")
    .setDescription("Show the standings. No arg = every division. Pass a division name for just one.")
    .addStringOption((opt) =>
      opt
        .setName("division")
        .setDescription("Division name (e.g. 'Rare 2'). Omit to see all divisions.")
        .setRequired(false)
        .setAutocomplete(true),
    ),

  autocomplete: divisionNameAutocomplete,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const activeSeason = await activePublicSeason();
    if (!activeSeason) {
      await interaction.editReply("No active season right now.");
      return;
    }

    const divisionArg = interaction.options.getString("division");
    if (divisionArg) {
      return renderSingleDivision(interaction, activeSeason.id, divisionArg);
    }
    return renderAllDivisions(interaction, activeSeason.id, activeSeason.name, activeSeason.targetGroupSize);
  },
};

async function renderSingleDivision(
  interaction: ChatInputCommandInteraction,
  seasonId: string,
  divisionName: string,
) {
  const division = await prisma.division.findFirst({
    where: { seasonId, name: divisionName },
  });
  if (!division) {
    await interaction.editReply(`No division named \`${divisionName}\` this season.`);
    return;
  }

  const [members, pairings] = await Promise.all([
    prisma.divisionMember.findMany({
      where: { divisionId: division.id },
      include: { player: true },
    }),
    prisma.pairing.findMany({
      where: { divisionId: division.id, status: "CONFIRMED" },
      select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
    }),
  ]);

  const droppedIds = new Set(members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
  const rows = computeStandings(members.map((m) => m.player), pairings).map((r) => ({
    ...r,
    dropped: droppedIds.has(r.player.id),
  }));
  await interaction.editReply(formatStandingsTable(division.name, rows));
}

async function renderAllDivisions(
  interaction: ChatInputCommandInteraction,
  seasonId: string,
  seasonName: string,
  targetGroupSize: number,
) {
  // Load tiers (top → bottom) with their divisions and per-division members/pairings.
  const tiers = await prisma.tier.findMany({
    where: { seasonId },
    orderBy: { position: "asc" },
    include: {
      divisions: {
        orderBy: { groupNumber: "asc" },
        include: {
          members: { include: { player: true } },
          pairings: {
            where: { status: "CONFIRMED" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
      },
    },
  });

  const totalDivisions = tiers.reduce((sum, t) => sum + t.divisions.length, 0);
  if (totalDivisions === 0) {
    await interaction.editReply("No divisions in the active season yet.");
    return;
  }

  const embeds: EmbedBuilder[] = [];
  let isFirst = true;
  for (const tier of tiers) {
    if (tier.divisions.length === 0) continue;

    const embed = new EmbedBuilder()
      .setColor(tierEmbedColor(tier.position))
      .setAuthor({ name: `${tier.name} tier` });
    if (isFirst) embed.setTitle(`🃏 ${seasonName} — Standings`);

    for (const div of tier.divisions) {
      const droppedIds = new Set(
        div.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
      );
      const rows = computeStandings(
        div.members.map((m) => m.player),
        div.pairings,
      ).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));
      embed.addFields({
        name: div.name,
        value: formatDivisionField(rows, targetGroupSize),
        inline: false,
      });
    }
    embeds.push(embed);
    isFirst = false;
  }

  // Discord allows up to 10 embeds per message and 6000 total chars.
  // One embed per tier is well under both limits for the default 4-tier pyramid.
  await interaction.editReply({ embeds });
}

