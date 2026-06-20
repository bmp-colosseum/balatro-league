import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { computeStandings, formatDivisionField, formatStandingsTable } from "../standings.js";
import { tierEmbedColor } from "../tiers.js";
import { divisionNameAutocomplete } from "./autocomplete.js";
import { formatSeasonLabel } from "../format-season.js";
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const activeSeason = await activePublicSeason();
      if (!activeSeason) {
        await interaction.editReply("No active season right now.");
        return;
      }

      const mySchedule = await buildMyScheduleEmbed(activeSeason.id, interaction.user.id);

      const divisionArg = interaction.options.getString("division");
      if (divisionArg) {
        await renderSingleDivision(interaction, activeSeason.id, divisionArg, mySchedule);
        return;
      }
      await renderAllDivisions(interaction, activeSeason.id, formatSeasonLabel(activeSeason), activeSeason.targetGroupSize, mySchedule);
    } catch (err) {
      console.error("[/standings] failed:", err);
      await interaction
        .editReply("⚠️ Couldn't load standings right now. It's been logged — try again shortly, or run `/schedule` to see your matchups.")
        .catch(() => {});
    }
  },
};

// The caller's own schedule: their assigned opponents in their division + the
// status of each (not played / reported / won-lost). Null if they're not in the
// active season or have no matches yet.
async function buildMyScheduleEmbed(seasonId: string, discordId: string): Promise<EmbedBuilder | null> {
  const player = await prisma.player.findUnique({ where: { discordId }, select: { id: true } });
  if (!player) return null;
  const membership = await prisma.divisionMember.findFirst({
    where: { playerId: player.id, status: "ACTIVE", division: { seasonId } },
    include: { division: { select: { id: true, name: true } } },
  });
  if (!membership) return null;
  const matches = await prisma.match.findMany({
    where: {
      divisionId: membership.division.id,
      format: "LEAGUE_BO2",
      OR: [{ playerAId: player.id }, { playerBId: player.id }],
    },
    select: {
      playerAId: true,
      gamesWonA: true,
      gamesWonB: true,
      status: true,
      playerA: { select: { displayName: true } },
      playerB: { select: { displayName: true } },
    },
  });
  if (matches.length === 0) return null;

  const lines = matches.map((m) => {
    const isA = m.playerAId === player.id;
    const oppName = isA ? m.playerB.displayName : m.playerA.displayName;
    const my = isA ? m.gamesWonA : m.gamesWonB;
    const opp = isA ? m.gamesWonB : m.gamesWonA;
    let status: string;
    if (m.status === "CONFIRMED") {
      status = my > opp ? `✅ won ${my}–${opp}` : my < opp ? `❌ lost ${my}–${opp}` : `🤝 drew ${my}–${opp}`;
    } else if (m.status === "PENDING" && (my > 0 || opp > 0)) {
      status = `⏳ reported ${my}–${opp} (awaiting confirm)`;
    } else if (m.status === "DISPUTED") {
      status = "⚠ disputed";
    } else {
      status = "▫️ not played";
    }
    return `**${oppName}** — ${status}`;
  });
  const played = matches.filter((m) => m.status === "CONFIRMED").length;
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🗓️ Your schedule — ${membership.division.name}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `${played}/${matches.length} played · use /start-match @opponent to play` });
}

async function renderSingleDivision(
  interaction: ChatInputCommandInteraction,
  seasonId: string,
  divisionName: string,
  mySchedule: EmbedBuilder | null,
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
    prisma.match.findMany({
      where: { divisionId: division.id, status: "CONFIRMED", format: "LEAGUE_BO2" },
      select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
    }),
  ]);

  const droppedIds = new Set(members.filter((m) => m.status === "DROPPED").map((m) => m.playerId));
  const rows = computeStandings(members.map((m) => m.player), pairings).map((r) => ({
    ...r,
    dropped: droppedIds.has(r.player.id),
  }));
  await interaction.editReply({
    content: formatStandingsTable(division.name, rows),
    embeds: mySchedule ? [mySchedule] : [],
  });
}

async function renderAllDivisions(
  interaction: ChatInputCommandInteraction,
  seasonId: string,
  seasonName: string,
  targetGroupSize: number,
  mySchedule: EmbedBuilder | null,
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
          matches: {
            where: { format: "LEAGUE_BO2" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, status: true },
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
  // Single source of truth for "this season uses a fixed schedule" — drives the
  // progress-bar denominator (assigned count vs full round-robin).
  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { scheduleLocked: true } });
  const scheduleLocked = season?.scheduleLocked ?? false;

  const embeds: EmbedBuilder[] = [];
  if (mySchedule) embeds.push(mySchedule); // caller's own schedule first
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
      const confirmed = div.matches.filter((m) => m.status === "CONFIRMED");
      const rows = computeStandings(
        div.members.map((m) => m.player),
        confirmed,
      ).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));
      // Compact progress bar: matches played vs expected. If a schedule was
      // locked (pre-created matches exist), expected = the assigned count;
      // otherwise (legacy on-demand) it's a full round-robin = C(N,2).
      const activeCount = div.members.filter((m) => m.status === "ACTIVE").length;
      // Locked schedule → expected = the assigned (pre-created) count; otherwise
      // on-demand round-robin = C(N,2).
      const expectedMatches = scheduleLocked ? div.matches.length : (activeCount * (activeCount - 1)) / 2;
      const playedMatches = confirmed.length;
      const barWidth = 12;
      const pct = expectedMatches === 0 ? 0 : playedMatches / expectedMatches;
      // Clamp so a division whose confirmed count exceeds `expected` (e.g. games
      // involving since-dropped players) can't push the repeat() count negative.
      const filled = Math.max(0, Math.min(barWidth, Math.round(pct * barWidth)));
      const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
      const progressLine = `\`${bar}\` ${playedMatches}/${expectedMatches}\n`;
      const fieldValue = progressLine + formatDivisionField(rows, targetGroupSize);
      embed.addFields({
        name: div.name,
        // Discord caps a field value at 1024 chars — a big division would 400 the
        // whole reply. Truncate with a pointer to the single-division view.
        value:
          fieldValue.length > 1024
            ? fieldValue.slice(0, 980).replace(/\n[^\n]*$/, "") + `\n…\n_/standings division:${div.name} for the full table_`
            : fieldValue,
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

