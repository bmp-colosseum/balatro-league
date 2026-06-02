import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { getOrCreatePlayer } from "../players.js";
import { formatSeasonLabel } from "../format-season.js";
import type { SlashCommand } from "./types.js";

export const schedule: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Show your remaining matches in the current season."),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const me = await getOrCreatePlayer(interaction.user);
    const activeSeason = await activePublicSeason();
    if (!activeSeason) {
      await interaction.editReply("No active season right now.");
      return;
    }

    const membership = await prisma.divisionMember.findFirst({
      where: { playerId: me.id, division: { seasonId: activeSeason.id } },
      include: {
        division: {
          include: {
            members: { include: { player: true } },
            pairings: {
              include: { playerA: true, playerB: true },
            },
          },
        },
      },
    });

    if (!membership) {
      await interaction.editReply("You're not in a division this season.");
      return;
    }

    const div = membership.division;
    const opponents = div.members
      .filter((m) => m.playerId !== me.id && m.status === "ACTIVE")
      .map((m) => m.player);

    // Categorize each opponent
    interface Item { name: string; status: string }
    const remaining: Item[] = [];
    const youReported: Item[] = [];
    const theyReported: Item[] = [];
    const disputed: Item[] = [];
    const done: Item[] = [];

    for (const opp of opponents) {
      const p = div.pairings.find(
        (pr) =>
          (pr.playerAId === me.id && pr.playerBId === opp.id) ||
          (pr.playerAId === opp.id && pr.playerBId === me.id),
      );
      if (!p) {
        remaining.push({ name: opp.displayName, status: "" });
      } else if (p.status === "CONFIRMED") {
        const myGames = p.playerAId === me.id ? p.gamesWonA : p.gamesWonB;
        const oppGames = p.playerAId === me.id ? p.gamesWonB : p.gamesWonA;
        done.push({ name: opp.displayName, status: `${myGames}-${oppGames}` });
      } else if (p.status === "DISPUTED") {
        disputed.push({ name: opp.displayName, status: "" });
      } else if (p.status === "PENDING") {
        if (p.reporterId === me.id) {
          const myGames = p.playerAId === me.id ? p.gamesWonA : p.gamesWonB;
          const oppGames = p.playerAId === me.id ? p.gamesWonB : p.gamesWonA;
          youReported.push({ name: opp.displayName, status: `${myGames}-${oppGames} (you reported)` });
        } else {
          const myGames = p.playerAId === me.id ? p.gamesWonA : p.gamesWonB;
          const oppGames = p.playerAId === me.id ? p.gamesWonB : p.gamesWonA;
          theyReported.push({ name: opp.displayName, status: `${myGames}-${oppGames} (they reported — confirm/dispute)` });
        }
      }
    }

    function fmt(items: Item[]): string {
      if (items.length === 0) return "_(none)_";
      return items
        .map((i) => (i.status ? `• **${i.name}** — ${i.status}` : `• **${i.name}**`))
        .join("\n");
    }

    // ASCII progress bar — counts matches that are "settled" from
    // the player's POV (CONFIRMED + their own pending reports +
    // disputes count as advanced state, only "remaining" is unstarted).
    const settled = done.length + youReported.length + theyReported.length + disputed.length;
    const totalMatches = settled + remaining.length;
    const pct = totalMatches === 0 ? 0 : Math.round((settled / totalMatches) * 100);
    const barWidth = 20;
    const filled = Math.round((pct / 100) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
    const progressLine = `\`${bar}\` **${settled}/${totalMatches}** matches (${pct}%)`;

    const embed = new EmbedBuilder()
      .setTitle(`Your schedule — ${div.name}`)
      .setColor(0x5865f2)
      .setDescription(`Season: **${formatSeasonLabel(activeSeason)}**\n${progressLine}`)
      .addFields(
        ...(theyReported.length ? [{ name: `⚠️ Awaiting your confirmation (${theyReported.length})`, value: fmt(theyReported) }] : []),
        ...(remaining.length ? [{ name: `🎮 Still to play (${remaining.length})`, value: fmt(remaining) }] : []),
        ...(youReported.length ? [{ name: `⏳ Waiting on opponent (${youReported.length})`, value: fmt(youReported) }] : []),
        ...(disputed.length ? [{ name: `🔴 Disputed (${disputed.length})`, value: fmt(disputed) }] : []),
        ...(done.length ? [{ name: `✅ Done (${done.length})`, value: fmt(done) }] : []),
      );

    if (theyReported.length === 0 && remaining.length === 0 && youReported.length === 0 && disputed.length === 0) {
      embed.setDescription(`Season: **${formatSeasonLabel(activeSeason)}**\n\n🎉 You're done — all your sets are confirmed!`);
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
