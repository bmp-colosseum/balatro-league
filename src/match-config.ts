// Deck/stake pool config + helpers for generating a match's deck pool.
// Admin maintains the AllowedDeck and AllowedStake whitelists; the bot
// samples (deck × stake) pairs uniformly without same-combo duplicates.

import { prisma } from "./db.js";

export const DEFAULT_POOL_SIZE = 9;

// Cached in-memory; refreshed on every match so admin edits land quickly.
// (Postgres lookup is microseconds — no real reason to cache longer.)
export async function getAllowedDecks(): Promise<string[]> {
  const rows = await prisma.allowedDeck.findMany({ orderBy: { name: "asc" } });
  return rows.map((r) => r.name);
}
export async function getAllowedStakes(): Promise<string[]> {
  const rows = await prisma.allowedStake.findMany({ orderBy: { name: "asc" } });
  return rows.map((r) => r.name);
}

export interface DeckEntry {
  deck: string;
  stake: string;
}

// Sample N unique (deck, stake) combos from the cartesian product of
// allowed decks and allowed stakes. Uses a seeded RNG when one's passed
// so /admin auto-play can replay the same pool.
export function generatePool(
  decks: string[],
  stakes: string[],
  size: number = DEFAULT_POOL_SIZE,
  rand: () => number = Math.random,
): DeckEntry[] {
  // Build all possible combos
  const combos: DeckEntry[] = [];
  for (const deck of decks) {
    for (const stake of stakes) {
      combos.push({ deck, stake });
    }
  }
  if (combos.length < size) {
    // Pool too small — return what we have
    return shuffle(combos, rand);
  }
  return shuffle(combos, rand).slice(0, size);
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Seed Balatro's default decks + stakes if the tables are empty.
// Called on first /start-match if admin hasn't configured yet.
// Defaults live in src/data/match-defaults.json — the web app pulls the same
// file via web's sync-schema.mjs postinstall so both sides stay in sync.
import defaults from "./data/match-defaults.json" with { type: "json" };

export async function seedDefaultsIfEmpty(): Promise<void> {
  const [deckCount, stakeCount] = await Promise.all([
    prisma.allowedDeck.count(),
    prisma.allowedStake.count(),
  ]);
  if (deckCount === 0) {
    await prisma.allowedDeck.createMany({
      data: defaults.decks.map((name) => ({ name })),
    });
  }
  if (stakeCount === 0) {
    await prisma.allowedStake.createMany({
      data: defaults.stakes.map((name) => ({ name })),
    });
  }
}
