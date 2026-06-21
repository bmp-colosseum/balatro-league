// /random — fun rolls with no game-state side effects, grouped as subcommands
// (/random bans | deck | stake | combo). They roll from the same deck + stake
// pool /challenge uses (the casual preset), so a roll is always something you
// could actually play. Falls back to the full canonical Balatro set when no
// casual preset is configured, so it still works on a fresh server.

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

// Roll a full ban pool (deck+stake combos) so two players can ban it down
// themselves, outside the guided flow. Same pool size as a real league game
// (matchPolicy.poolSize, default 9) and the same casual deck/stake set.
async function rollBans(interaction: ChatInputCommandInteraction): Promise<void> {
  const { decks, stakes } = await rollPool();
  const { matchPolicy } = await getLeagueSettings();
  // Random SELECTION of combos, then ordered by stake (difficulty) → deck so
  // the list is grouped by stake. Labels read deck-first.
  const combos = generatePool(decks, stakes, matchPolicy.poolSize).sort(
    (a, b) =>
      canonicalStakeIndex(a.stake) - canonicalStakeIndex(b.stake) ||
      canonicalDeckIndex(a.deck) - canonicalDeckIndex(b.deck),
  );
  const lines = combos.map((c, i) => {
    const deck = `${deckEmoji(c.deck) ?? ""} ${c.deck}`.trim();
    const stake = `${stakeEmoji(c.stake) ?? ""} ${c.stake}`.trim();
    return `**${i + 1}.** ${deck} — ${stake}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`🎲 Random ban pool — ${combos.length} combos`)
    .setColor(0x9b59b6)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Playing a league match? Use /start-match for the guided ban/pick + auto-record." });
  await interaction.reply({ embeds: [embed] });
}

// One /random command with subcommands instead of /random-deck etc. — no dashes
// to type, and the rolls group under one entry. `bans` is listed first as the
// common one. Posts a public embed, so it's confined to the bot-commands channel(s).
export const random: SlashCommand = {
  channelScope: "bot-commands-only",
  data: new SlashCommandBuilder()
    .setName("random")
    .setDescription("Roll a random ban pool, deck, or stake from the challenge pool.")
    .addSubcommand((s) => s.setName("bans").setDescription("Roll a ban pool (deck+stake combos) to ban down yourselves."))
    .addSubcommand((s) => s.setName("deck").setDescription("Roll a random deck."))
    .addSubcommand((s) => s.setName("stake").setDescription("Roll a random stake."))
    .addSubcommand((s) => s.setName("combo").setDescription("Roll a random deck + stake together.")),
  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "bans") return rollBans(interaction);
    const { decks, stakes } = await rollPool();
    if (sub === "deck") {
      await interaction.reply({ embeds: [rollEmbed({ deck: pick(decks) })] });
      return;
    }
    if (sub === "stake") {
      await interaction.reply({ embeds: [rollEmbed({ stake: pick(stakes) })] });
      return;
    }
    // combo
    await interaction.reply({ embeds: [rollEmbed({ deck: pick(decks), stake: pick(stakes) })] });
  },
};
