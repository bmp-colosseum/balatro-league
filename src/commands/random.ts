// /random, /random-deck, /random-stake — fun rolls, no game-state side
// effects. /random is the headline (deck + stake together); the two
// single-item variants are the less-used cousins. All roll from the full
// canonical Balatro set so they work in any server with no preset config.

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { CANONICAL_DECKS, CANONICAL_STAKES, deckDescription, stakeDescription } from "../balatro-info.js";
import { deckEmoji, stakeEmoji } from "../balatro-emojis.js";
import type { SlashCommand } from "./types.js";

function pickName(items: readonly { name: string }[]): string {
  return items[Math.floor(Math.random() * items.length)]!.name;
}

// Build the roll embed for any combination of deck/stake. Descriptions
// (and the custom emoji styling used across match-render) are added when
// present, falling back to an empty string when the emoji isn't
// registered yet on a fresh server.
function rollEmbed(opts: { deck?: string; stake?: string }): EmbedBuilder {
  const { deck, stake } = opts;
  const deckIcon = deck ? deckEmoji(deck) ?? "" : "";
  const stakeIcon = stake ? stakeEmoji(stake) ?? "" : "";

  const headline: string[] = [];
  if (deck) headline.push(`${deckIcon} **${deck}**`.trim());
  if (stake) headline.push(`${stakeIcon} **${stake}**`.trim());

  const embed = new EmbedBuilder()
    .setTitle("🎲 Random roll")
    .setColor(0x9b59b6)
    .setDescription(headline.join(" / "));

  const fields: { name: string; value: string; inline: boolean }[] = [];
  if (deck) {
    const d = deckDescription(deck);
    if (d) fields.push({ name: `${deckIcon} ${deck}`.trim(), value: d, inline: false });
  }
  if (stake) {
    const s = stakeDescription(stake);
    if (s) fields.push({ name: `${stakeIcon} ${stake}`.trim(), value: s, inline: false });
  }
  if (fields.length > 0) embed.addFields(...fields);
  return embed;
}

export const random: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("random")
    .setDescription("Roll a random deck + stake."),
  async execute(interaction: ChatInputCommandInteraction) {
    const embed = rollEmbed({ deck: pickName(CANONICAL_DECKS), stake: pickName(CANONICAL_STAKES) });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export const randomDeck: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("random-deck")
    .setDescription("Roll a random deck."),
  async execute(interaction: ChatInputCommandInteraction) {
    const embed = rollEmbed({ deck: pickName(CANONICAL_DECKS) });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export const randomStake: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("random-stake")
    .setDescription("Roll a random stake."),
  async execute(interaction: ChatInputCommandInteraction) {
    const embed = rollEmbed({ stake: pickName(CANONICAL_STAKES) });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
