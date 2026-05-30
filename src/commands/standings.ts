import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Rarity } from "@prisma/client";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { PLAYERS_PER_DIVISION } from "../pyramid.js";
import { computeStandings, formatDivisionField, formatStandingsTable } from "../standings.js";
import { divisionNameAutocomplete } from "./autocomplete.js";
import type { SlashCommand } from "./types.js";

const RARITY_COLOR: Record<Rarity, number> = {
  LEGENDARY: 0xf1c40f, // gold
  RARE: 0x9b59b6,      // purple
  UNCOMMON: 0x3498db,  // blue
  COMMON: 0x95a5a6,    // grey
};

const RARITY_LABEL: Record<Rarity, string> = {
  LEGENDARY: "Legendary",
  RARE: "Rare",
  UNCOMMON: "Uncommon",
  COMMON: "Common",
};

const RARITY_ORDER: Rarity[] = ["LEGENDARY", "RARE", "UNCOMMON", "COMMON"];

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
  const divisions = await prisma.division.findMany({
    where: { seasonId },
    include: {
      members: { include: { player: true } },
      pairings: {
        where: { status: "CONFIRMED" },
        select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
      },
    },
    orderBy: [{ rarity: "asc" }, { groupNumber: "asc" }],
  });

  if (divisions.length === 0) {
    await interaction.editReply("No divisions in the active season yet.");
    return;
  }

  // Group by rarity → one embed per rarity, divisions as fields.
  const byRarity = new Map<Rarity, typeof divisions>();
  for (const d of divisions) {
    if (!byRarity.has(d.rarity)) byRarity.set(d.rarity, []);
    byRarity.get(d.rarity)!.push(d);
  }

  const embeds: EmbedBuilder[] = [];
  let isFirst = true;
  for (const rarity of RARITY_ORDER) {
    const divs = byRarity.get(rarity);
    if (!divs || divs.length === 0) continue;

    const embed = new EmbedBuilder()
      .setColor(RARITY_COLOR[rarity])
      .setAuthor({ name: `${RARITY_LABEL[rarity]} tier` });
    if (isFirst) embed.setTitle(`🃏 ${seasonName} — Standings`);

    for (const div of divs) {
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
  // 4 embeds (one per rarity) is well under both limits.
  await interaction.editReply({ embeds });
}

