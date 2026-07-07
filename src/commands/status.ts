import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type User,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { formatSeasonLabel } from "../format-season.js";
import { computeStandings } from "../standings.js";
import type { SlashCommand } from "./types.js";

// Shared core for /status + the division control-panel "My standings" button:
// the caller's division, rank, points, record, and who's left to play. Returns a
// ready reply payload — { content } for the not-in-season cases, { embeds } for
// the status card — so both a slash command and a button can editReply it.
export async function buildStatusReply(
  user: User,
  guildName: string | undefined,
): Promise<{ content?: string; embeds?: EmbedBuilder[] }> {
  const me = await getOrCreatePlayer(user, guildName);
  const activeSeason = await activePublicSeason();
  if (!activeSeason) return { content: "No active season right now." };

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId: me.id, status: "ACTIVE", division: { seasonId: activeSeason.id } },
    include: {
      division: {
        include: {
          tier: true,
          members: { where: { status: "ACTIVE" }, include: { player: true } },
          matches: {
            where: { format: "LEAGUE_BO2" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, status: true },
          },
        },
      },
    },
  });
  if (!membership) {
    return { content: "You're not in a division this season. Once you're placed, `/schedule` shows your matches." };
  }

  const div = membership.division;
  const confirmed = div.matches.filter((m) => m.status === "CONFIRMED");
  const rows = computeStandings(div.members.map((m) => m.player), confirmed);
  const myRow = rows.find((r) => r.player.id === me.id);
  if (!myRow) {
    return { content: `You're in **${div.name}**, but no standings row yet — play a match and it'll show up.` };
  }
  const rank = myRow.rank ?? rows.findIndex((r) => r.player.id === me.id) + 1;

  // Opponents still to play = your pre-created matchups that haven't been played
  // yet (PENDING + 0-0). Mirrors /schedule's "still to play".
  const nameById = new Map(div.members.map((m) => [m.player.id, m.player.displayName]));
  const remaining = div.matches
    .filter(
      (m) =>
        (m.playerAId === me.id || m.playerBId === me.id) &&
        m.status === "PENDING" &&
        m.gamesWonA === 0 &&
        m.gamesWonB === 0,
    )
    .map((m) => nameById.get(m.playerAId === me.id ? m.playerBId : m.playerAId) ?? "?");

  const embed = new EmbedBuilder()
    .setTitle(`Your status — ${div.name}`)
    .setColor(0x5865f2)
    .setDescription(
      `**${formatSeasonLabel(activeSeason)}** · ${div.tier.name} tier\n\n` +
        `🏅 **#${rank}** of ${rows.length}\n` +
        `**${myRow.points}** pts · ${myRow.wins}W · ${myRow.draws}D · ${myRow.losses}L  _(${myRow.played} played)_\n\n` +
        (remaining.length
          ? `🎮 **${remaining.length} left to play:** ${remaining.join(", ")}`
          : "✅ All your matches are done!"),
    );
  return { embeds: [embed] };
}

// /status — "where do I stand right now": your division, rank, points, record.
// The standing half of the picture; /schedule is the matches half.
export const status: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Where you stand this season — your division, rank, points, and record."),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await buildStatusReply(interaction.user, guildDisplayName(interaction)));
  },
};
