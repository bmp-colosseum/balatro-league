// /random, /random-deck, /random-stake — fun rolls, no game-state side
// effects. /random is the headline (deck + stake together); the two
// single-item variants are the less-used cousins. They roll from the same
// deck + stake pool /challenge uses (the casual preset), so a roll is always
// something you could actually play. Falls back to the full canonical Balatro
// set when no casual preset is configured, so it still works on a fresh server.

import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { CANONICAL_DECKS, CANONICAL_STAKES, canonicalDeckIndex, canonicalStakeIndex, deckDescription, stakeDescription } from "../balatro-info.js";
import { deckEmoji, stakeEmoji } from "../balatro-emojis.js";
import { presetForCasualMatch, generatePool } from "../match-config.js";
import { getLeagueSettings } from "../league-settings.js";
import type { SlashCommand } from "./types.js";

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

// Resolve the deck + stake names to roll from: the casual preset (same pool as
// /challenge) when set, otherwise the full canonical set so a fresh server with
// no preset still rolls something.
async function rollPool(): Promise<{ decks: string[]; stakes: string[] }> {
  const preset = await presetForCasualMatch();
  return {
    decks: preset && preset.decks.length > 0 ? preset.decks : CANONICAL_DECKS.map((d) => d.name),
    stakes: preset && preset.stakes.length > 0 ? preset.stakes : CANONICAL_STAKES.map((s) => s.name),
  };
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
  // Posts a public embed in the invoking channel, so confine it to the
  // allowed bot-commands channel(s) to avoid spamming general/division chat.
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("random")
    .setDescription("Roll a random deck + stake from the challenge pool."),
  async execute(interaction: ChatInputCommandInteraction) {
    const { decks, stakes } = await rollPool();
    const embed = rollEmbed({ deck: pick(decks), stake: pick(stakes) });
    await interaction.reply({ embeds: [embed] });
  },
};

export const randomDeck: SlashCommand = {
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("random-deck")
    .setDescription("Roll a random deck from the challenge pool."),
  async execute(interaction: ChatInputCommandInteraction) {
    const { decks } = await rollPool();
    const embed = rollEmbed({ deck: pick(decks) });
    await interaction.reply({ embeds: [embed] });
  },
};

export const randomStake: SlashCommand = {
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("random-stake")
    .setDescription("Roll a random stake from the challenge pool."),
  async execute(interaction: ChatInputCommandInteraction) {
    const { stakes } = await rollPool();
    const embed = rollEmbed({ stake: pick(stakes) });
    await interaction.reply({ embeds: [embed] });
  },
};

// /random-bans — roll a full ban pool (deck+stake combos) so two players can
// ban it down themselves, outside the guided flow. Same pool size as a real
// league game (matchPolicy.poolSize, default 9) and the same casual deck/stake
// set /challenge and /random draw from.
export const randomBans: SlashCommand = {
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("random-bans")
    .setDescription("Roll a random ban pool (deck+stake combos) to ban down yourselves."),
  async execute(interaction: ChatInputCommandInteraction) {
    const { decks, stakes } = await rollPool();
    const { matchPolicy } = await getLeagueSettings();
    // Random SELECTION of combos, then sorted by stake (difficulty) → deck so
    // the list reads stake-first the way people think about bans.
    const combos = generatePool(decks, stakes, matchPolicy.poolSize).sort(
      (a, b) =>
        canonicalStakeIndex(a.stake) - canonicalStakeIndex(b.stake) ||
        canonicalDeckIndex(a.deck) - canonicalDeckIndex(b.deck),
    );
    const lines = combos.map((c, i) => {
      const stake = `${stakeEmoji(c.stake) ?? ""} ${c.stake}`.trim();
      const deck = `${deckEmoji(c.deck) ?? ""} ${c.deck}`.trim();
      return `**${i + 1}.** ${stake} — ${deck}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`🎲 Random ban pool — ${combos.length} combos`)
      .setColor(0x9b59b6)
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Ban it down between you — same pool /challenge uses." });
    await interaction.reply({ embeds: [embed] });
  },
};
