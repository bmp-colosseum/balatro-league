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
import { deckEmoji, stakeEmoji } from "../balatro-emojis.js";
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
    // Same custom-emoji styling the match-render uses for the
    // ban/pick pool — falls back to empty string when the emoji
    // isn't registered (e.g. fresh server before ensureBalatroEmojis).
    const deckIcon = deckEmoji(deck) ?? "";
    const stakeIcon = stakeEmoji(stake) ?? "";

    const embed = new EmbedBuilder()
      .setTitle("🎲 Random roll")
      .setColor(0x9b59b6)
      .setDescription(
        `${deckIcon} **${deck}** / ${stakeIcon} **${stake}**`.trim(),
      )
      .addFields(
        ...(deckDesc
          ? [{ name: `${deckIcon} ${deck}`.trim(), value: deckDesc, inline: false }]
          : []),
        ...(stakeDesc
          ? [{ name: `${stakeIcon} ${stake}`.trim(), value: stakeDesc, inline: false }]
          : []),
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
