// /pool — let players see which decks + stakes are currently in rotation,
// so the ban/pick pool isn't a mystery. Shows the active season's league pool
// and the casual /challenge pool; if they're the same preset it's shown once.
// Falls back to the full canonical set when nothing is configured.

import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "../balatro-info.js";
import { deckEmoji, stakeEmoji } from "../balatro-emojis.js";
import { presetForCasualMatch, presetForSeason } from "../match-config.js";
import { activePublicSeason } from "../active-season.js";
import { formatSeasonLabel } from "../format-season.js";
import type { SlashCommand } from "./types.js";

interface PresetLike {
  id: string;
  decks: string[];
  stakes: string[];
}

function namesOf(preset: PresetLike | null): { decks: string[]; stakes: string[] } {
  return {
    decks: preset && preset.decks.length > 0 ? preset.decks : CANONICAL_DECKS.map((d) => d.name),
    stakes: preset && preset.stakes.length > 0 ? preset.stakes : CANONICAL_STAKES.map((s) => s.name),
  };
}

function fmt(names: string[], emoji: (n: string) => string | null): string {
  return names.map((n) => `${emoji(n) ?? ""} ${n}`.trim()).join("  •  ");
}

function poolFields(label: string, preset: PresetLike | null) {
  const { decks, stakes } = namesOf(preset);
  return [
    { name: label, value: "​" },
    { name: `🃏 Decks (${decks.length})`, value: fmt(decks, deckEmoji) },
    { name: `♠ Stakes (${stakes.length})`, value: fmt(stakes, stakeEmoji) },
  ];
}

export const pool: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("pool")
    .setDescription("Show the decks + stakes currently in rotation."),
  async execute(interaction: ChatInputCommandInteraction) {
    const [casual, season] = await Promise.all([presetForCasualMatch(), activePublicSeason()]);
    const leaguePreset = season ? await presetForSeason(season.id) : null;
    const samePreset = !!(leaguePreset && casual && leaguePreset.id === casual.id);

    const embed = new EmbedBuilder().setTitle("🃏 Deck & stake pools").setColor(0x9b59b6);

    if (season) {
      const label = samePreset
        ? `🏆 ${formatSeasonLabel(season)} & 🎴 Challenge`
        : `🏆 League — ${formatSeasonLabel(season)}`;
      embed.addFields(...poolFields(label, leaguePreset ?? casual));
    }
    if (!samePreset) {
      embed.addFields(...poolFields("🎴 Challenge", casual));
    }

    embed.setFooter({ text: "Roll one with /random, or a full ban pool with /random-bans." });
    await interaction.reply({ embeds: [embed] });
  },
};
