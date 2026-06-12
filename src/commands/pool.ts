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
import { presetForCasualMatch, presetForCustomCombo, presetForSeason } from "../match-config.js";
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
  // Posts a public embed in the invoking channel → confine to the allowed
  // bot-commands channel(s).
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("pool")
    .setDescription("Show the decks + stakes currently in rotation."),
  async execute(interaction: ChatInputCommandInteraction) {
    const [casual, custom, season] = await Promise.all([
      presetForCasualMatch(),
      presetForCustomCombo(),
      activePublicSeason(),
    ]);
    const leaguePreset = season ? await presetForSeason(season.id) : null;

    // Each "context" that has a pool, in display order. Contexts that resolve
    // to the SAME preset are merged into one section so we don't repeat an
    // identical deck list (custom-combo falls back to the casual preset, so
    // they're usually the same).
    const contexts: Array<{ label: string; preset: PresetLike | null }> = [];
    if (season) contexts.push({ label: `🏆 ${formatSeasonLabel(season)}`, preset: leaguePreset ?? casual });
    contexts.push({ label: "🎴 Challenge", preset: casual });
    contexts.push({ label: "🎛 Custom combos", preset: custom });

    const groups = new Map<string, { labels: string[]; preset: PresetLike | null }>();
    for (const c of contexts) {
      const key = c.preset?.id ?? "__canonical__";
      const g = groups.get(key);
      if (g) g.labels.push(c.label);
      else groups.set(key, { labels: [c.label], preset: c.preset });
    }

    const embed = new EmbedBuilder().setTitle("🃏 Deck & stake pools").setColor(0x9b59b6);
    for (const g of groups.values()) {
      embed.addFields(...poolFields(g.labels.join(" & "), g.preset));
    }
    embed.setFooter({ text: "Roll one with /random, or a full ban pool with /random-bans." });
    await interaction.reply({ embeds: [embed] });
  },
};
