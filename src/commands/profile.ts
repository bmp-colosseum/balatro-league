import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { prisma } from "../db.js";
import { getOrCreatePlayer } from "../players.js";
import { loadPlayerHistory } from "../profile.js";
import type { SlashCommand } from "./types.js";

// Tier-position-based emoji. Mirrors the default Legendary/Rare/Uncommon/Common palette
// but works for any season's custom tier names.
const TIER_POSITION_EMOJI: Record<number, string> = {
  1: "🟡",
  2: "🟣",
  3: "🔵",
  4: "⚪",
};

export const profile: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Show season-by-season history for yourself or another player.")
    .addUserOption((opt) =>
      opt.setName("player").setDescription("Player to look up (defaults to you)").setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const user = interaction.options.getUser("player") ?? interaction.user;
    const player = await prisma.player.findUnique({ where: { discordId: user.id } });
    if (!player) {
      // Auto-create from Discord if it's the caller looking up themselves
      if (user.id === interaction.user.id) {
        await getOrCreatePlayer(user);
      } else {
        await interaction.editReply(`${user.username} isn't registered in the league.`);
        return;
      }
    }
    const existing = await prisma.player.findUnique({ where: { discordId: user.id } });
    if (!existing) {
      await interaction.editReply(`${user.username} isn't in the league yet.`);
      return;
    }

    const history = await loadPlayerHistory(existing.id);
    if (!history) {
      await interaction.editReply("Couldn't load profile.");
      return;
    }

    const t = history.totals;
    const lines: string[] = [];
    if (history.history.length === 0) {
      lines.push("_No season history yet — placed in 0 divisions._");
    } else {
      for (const h of history.history) {
        const emoji = TIER_POSITION_EMOJI[h.tierPosition] ?? "▫️";
        const activeMarker = h.isActive ? " · _active_" : "";
        const droppedMarker = h.status === "DROPPED" ? " · ⚠️ dropped" : "";
        const rankStr = h.rank > 0 ? `#${h.rank}/${h.totalMembers}` : "—";
        lines.push(
          `${emoji} **${h.seasonName}** · ${h.divisionName} · ${rankStr} · ${h.points} pts · ${h.wins}-${h.draws}-${h.losses}${activeMarker}${droppedMarker}`,
        );
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`${existing.displayName} — profile`)
      .setColor(0x5865f2)
      .addFields(
        { name: "Seasons played", value: String(t.seasons), inline: true },
        { name: "Total points", value: String(t.points), inline: true },
        { name: "Best rank", value: t.bestRank ? `#${t.bestRank}` : "—", inline: true },
        { name: "Record (W-D-L)", value: `${t.wins}-${t.draws}-${t.losses}`, inline: true },
      )
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Discord ID: ${existing.discordId}` });

    await interaction.editReply({ embeds: [embed] });
  },
};
