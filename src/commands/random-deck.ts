// /random-deck — picks one random deck (and stake) from the season's
// default preset. For fun: someone wants a fresh combo to try, doesn't
// want to scroll the BMP wiki to pick. Has no game-state side effects;
// purely a roll.

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { resolveDefaultSeasonPreset } from "../match-config.js";
import { deckDescription, stakeDescription } from "../balatro-info.js";
import type { SlashCommand } from "./types.js";

export const randomDeck: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("random-deck")
    .setDescription("Roll a random deck + stake from the league's default pool."),

  async execute(interaction: ChatInputCommandInteraction) {
    const preset = await resolveDefaultSeasonPreset();
    if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
      await interaction.reply({
        content:
          "No default preset is configured yet (or it has no decks/stakes). Ask an admin to set one up on /admin/deck-bans.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const deck = preset.decks[Math.floor(Math.random() * preset.decks.length)]!;
    const stake = preset.stakes[Math.floor(Math.random() * preset.stakes.length)]!;
    const deckDesc = deckDescription(deck);
    const stakeDesc = stakeDescription(stake);

    const embed = new EmbedBuilder()
      .setTitle("🎲 Random roll")
      .setColor(0x9b59b6)
      .addFields(
        {
          name: "Deck",
          value: deckDesc ? `**${deck}** — ${deckDesc}` : `**${deck}**`,
          inline: false,
        },
        {
          name: "Stake",
          value: stakeDesc ? `**${stake}** — ${stakeDesc}` : `**${stake}**`,
          inline: false,
        },
      )
      .setFooter({ text: `Rolled from "${preset.name}" preset` });

    await interaction.reply({ embeds: [embed] });
  },
};
