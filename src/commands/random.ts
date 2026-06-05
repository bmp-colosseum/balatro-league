// /random, /random-deck, /random-stake — fun rolls, no game-state side
// effects. /random is the headline (deck + stake together); the two
// single-item variants are the less-used cousins. All roll from the full
// canonical Balatro set so they work in any server with no preset config.

import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { CANONICAL_DECKS, CANONICAL_STAKES, deckDescription, stakeDescription } from "../balatro-info.js";
import { deckEmoji, stakeEmoji } from "../balatro-emojis.js";
import type { SlashCommand } from "./types.js";

function pickName(items: readonly { name: string }[]): string {
  return items[Math.floor(Math.random() * items.length)]!.name;
}

// One block per rolled item: emoji + name on one line, its description
// below. Shown once each (no repeated name), so it reads cleanly whether
// it's one item or both. Emoji falls back to "" when not registered yet.
function block(icon: string, name: string, desc: string | undefined): string {
  const head = `${icon} **${name}**`.trim();
  return desc ? `${head}\n${desc}` : head;
}

function rollEmbed(opts: { deck?: string; stake?: string }): EmbedBuilder {
  const { deck, stake } = opts;
  const blocks: string[] = [];
  if (deck) blocks.push(block(deckEmoji(deck) ?? "", deck, deckDescription(deck)));
  if (stake) blocks.push(block(stakeEmoji(stake) ?? "", stake, stakeDescription(stake)));
  return new EmbedBuilder()
    .setTitle("🎲 Random roll")
    .setColor(0x9b59b6)
    .setDescription(blocks.join("\n\n"));
}

export const random: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("random")
    .setDescription("Roll a random deck + stake."),
  async execute(interaction: ChatInputCommandInteraction) {
    const embed = rollEmbed({ deck: pickName(CANONICAL_DECKS), stake: pickName(CANONICAL_STAKES) });
    await interaction.reply({ embeds: [embed] });
  },
};

export const randomDeck: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("random-deck")
    .setDescription("Roll a random deck."),
  async execute(interaction: ChatInputCommandInteraction) {
    const embed = rollEmbed({ deck: pickName(CANONICAL_DECKS) });
    await interaction.reply({ embeds: [embed] });
  },
};

export const randomStake: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("random-stake")
    .setDescription("Roll a random stake."),
  async execute(interaction: ChatInputCommandInteraction) {
    const embed = rollEmbed({ stake: pickName(CANONICAL_STAKES) });
    await interaction.reply({ embeds: [embed] });
  },
};
