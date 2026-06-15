// /pool — let players see which decks + stakes are currently in rotation,
// so the ban/pick pool isn't a mystery. Each section is labelled with the
// COMMAND(S) that draw from it, so people can connect "what shows up" to
// "what I type". Shows the active season's league pool, the casual /challenge
// pool, and the custom-combo pool; contexts sharing a preset are merged.
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

// One embed field per pool: a heading that names the match type + the command
// you'd use, then the decks and stakes that pool currently contains.
function poolField(heading: string, commands: string, preset: PresetLike | null) {
  const { decks, stakes } = namesOf(preset);
  return {
    name: heading,
    value: [
      `*Used by:* ${commands}`,
      `🃏 **Decks (${decks.length}):** ${fmt(decks, deckEmoji)}`,
      `♠ **Stakes (${stakes.length}):** ${fmt(stakes, stakeEmoji)}`,
    ].join("\n"),
  };
}

export const pool: SlashCommand = {
  // Posts a public embed in the invoking channel → confine to the allowed
  // bot-commands channel(s).
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("pool")
    .setDescription("Show which decks + stakes each match type uses."),
  async execute(interaction: ChatInputCommandInteraction) {
    const [casual, custom, season] = await Promise.all([
      presetForCasualMatch(),
      presetForCustomCombo(),
      activePublicSeason(),
    ]);
    const leaguePreset = season ? await presetForSeason(season.id) : null;

    // Each "context" that has a pool, in display order, tagged with the
    // command(s) that draw from it. Contexts that resolve to the SAME preset
    // are merged into one section so we don't repeat an identical list
    // (custom-combo falls back to the casual preset, so they're often equal).
    const contexts: Array<{ heading: string; commands: string; preset: PresetLike | null }> = [];
    if (season) {
      contexts.push({
        heading: `🏆 League matches — ${formatSeasonLabel(season)}`,
        commands: "`/start-match`",
        preset: leaguePreset ?? casual,
      });
    }
    contexts.push({
      heading: "🎴 Casual & random rolls",
      commands: "`/challenge` • `/random bans` • `/random deck` • `/random stake`",
      preset: casual,
    });
    contexts.push({
      heading: "🎛️ Custom combos",
      commands: "the in-match “pick a custom combo” option",
      preset: custom,
    });

    // Merge contexts that share a preset, keeping each context's heading +
    // command list so the combined section still shows what feeds what.
    const groups = new Map<string, { headings: string[]; commands: string[]; preset: PresetLike | null }>();
    for (const c of contexts) {
      const key = c.preset?.id ?? "__canonical__";
      const g = groups.get(key);
      if (g) {
        g.headings.push(c.heading);
        g.commands.push(c.commands);
      } else {
        groups.set(key, { headings: [c.heading], commands: [c.commands], preset: c.preset });
      }
    }

    const embed = new EmbedBuilder()
      .setTitle("🃏 What’s in rotation")
      .setDescription(
        "A **pool** is the set of decks and stakes a match can ban and pick from. " +
          "Each match type uses its own pool — here’s what’s currently in each:",
      )
      .setColor(0x9b59b6);
    for (const g of groups.values()) {
      embed.addFields(poolField(g.headings.join("  +  "), g.commands.join("  •  "), g.preset));
    }
    embed.setFooter({
      text: "/random combo rolls one • /random bans rolls a 9-combo ban pool",
    });
    await interaction.reply({ embeds: [embed] });
  },
};
