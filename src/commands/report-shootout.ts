// /report-shootout — self-service shootout reporting. Auto-confirmed like
// /report: trust the reporter, opponent can ask Helper/Admin to revise
// via /admin record-shootout if it landed wrong.
//
// A shootout is a 1-game tiebreaker between two players in the same
// division who finished tied on points + drew their h2h pairing. Only
// makes sense at promo/relegation boundary positions, but we don't
// enforce that — sortStandings just picks up any recorded shootout
// when it's relevant.
//
// The opponent picker is autocompleted to ONLY the requester's
// same-division active members — Discord's default user picker would
// let them pick anyone in the server, which is confusing and lets them
// pick someone they can't have a shootout against. The autocomplete
// value carries the opponent's Discord ID directly.

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { __shootoutHelper } from "./admin.js";
import { sameDivisionMemberAutocomplete } from "./autocomplete.js";
import type { SlashCommand } from "./types.js";

const WINNER_CHOICES = [
  { name: "I won the shootout", value: "self" },
  { name: "Opponent won the shootout", value: "opponent" },
] as const;

export const reportShootout: SlashCommand = {
  // No channelScope — ephemeral ack, no public side-effect channel needed.
  data: new SlashCommandBuilder()
    .setName("report-shootout")
    .setDescription("Record the result of a 1-game shootout against a tied opponent.")
    .addStringOption((opt) =>
      opt
        .setName("opponent")
        .setDescription("The player you played the shootout against")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("winner")
        .setDescription("Who won the shootout")
        .setRequired(true)
        .addChoices(...WINNER_CHOICES),
    ),

  autocomplete: sameDivisionMemberAutocomplete,

  async execute(interaction: ChatInputCommandInteraction) {
    const opponentDiscordId = interaction.options.getString("opponent", true).trim();
    const winnerKey = interaction.options.getString("winner", true);
    if (!/^\d{17,20}$/.test(opponentDiscordId)) {
      await interaction.reply({
        content: "Pick an opponent from the dropdown — only same-division members are eligible.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (opponentDiscordId === interaction.user.id) {
      await interaction.reply({ content: "You can't shootout against yourself.", flags: MessageFlags.Ephemeral });
      return;
    }
    const winnerDiscordId = winnerKey === "self" ? interaction.user.id : opponentDiscordId;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await __shootoutHelper({
      p1DiscordId: interaction.user.id,
      p2DiscordId: opponentDiscordId,
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
