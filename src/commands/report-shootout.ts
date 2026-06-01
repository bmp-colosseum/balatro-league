// /report-shootout — self-service shootout reporting. Auto-confirmed like
// /report: trust the reporter, opponent can ask Helper/Admin to revise
// via /admin record-shootout if it landed wrong.
//
// A shootout is a 1-game tiebreaker between two players in the same
// division who finished tied on points + drew their h2h pairing. Only
// makes sense at promo/relegation boundary positions, but we don't
// enforce that — sortStandings just picks up any recorded shootout
// when it's relevant.

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { __shootoutHelper } from "./admin.js";
import type { SlashCommand } from "./types.js";

const WINNER_CHOICES = [
  { name: "I won the shootout", value: "self" },
  { name: "Opponent won the shootout", value: "opponent" },
] as const;

export const reportShootout: SlashCommand = {
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("report-shootout")
    .setDescription("Record the result of a 1-game shootout against a tied opponent.")
    .addUserOption((opt) =>
      opt.setName("opponent").setDescription("The player you played the shootout against").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("winner")
        .setDescription("Who won the shootout")
        .setRequired(true)
        .addChoices(...WINNER_CHOICES),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const opponent = interaction.options.getUser("opponent", true);
    const winnerKey = interaction.options.getString("winner", true);
    if (opponent.id === interaction.user.id) {
      await interaction.reply({ content: "You can't shootout against yourself.", flags: MessageFlags.Ephemeral });
      return;
    }
    const winnerDiscordId = winnerKey === "self" ? interaction.user.id : opponent.id;
    await interaction.deferReply();
    const result = await __shootoutHelper({
      p1DiscordId: interaction.user.id,
      p2DiscordId: opponent.id,
      winnerDiscordId,
      recordedBy: "self-report",
    });
    if (!result.ok) {
      await interaction.editReply(result.error);
      return;
    }
    await interaction.editReply(
      `⚔ Shootout recorded — **${result.winnerName}** wins the tiebreaker in **${result.divisionName}**. ` +
        `Standings sort updated. If something looks wrong, ask a Helper to re-record via \`/admin record-shootout\`.`,
    );
  },
};
