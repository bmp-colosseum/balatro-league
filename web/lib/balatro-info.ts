// Web-side mirror of src/balatro-info.ts. Same canonical list of decks
// and stakes with effect descriptions, used by the preset editor's
// 'Add' dropdowns and by any UI surface that wants to show description
// tooltips. JSON file is synced from the bot's src/data/ on web install.

import info from "./balatro-info.json" with { type: "json" };

export interface BalatroItem {
  name: string;
  description: string;
  emoji?: string;
}

export const CANONICAL_DECKS: readonly BalatroItem[] = info.decks;
export const CANONICAL_STAKES: readonly BalatroItem[] = info.stakes;

const deckByName = new Map(CANONICAL_DECKS.map((d) => [d.name.toLowerCase(), d]));
const stakeByName = new Map(CANONICAL_STAKES.map((s) => [s.name.toLowerCase(), s]));

// Unicode-emoji fallback for a stake without PNG art (custom mod stakes).
export function stakeEmojiChar(name: string): string | undefined {
  return stakeByName.get(name.toLowerCase())?.emoji;
}

export function deckDescription(name: string): string | undefined {
  return deckByName.get(name.toLowerCase())?.description;
}

export function stakeDescription(name: string): string | undefined {
  return stakeByName.get(name.toLowerCase())?.description;
}

export function isCanonicalDeck(name: string): boolean {
  return deckByName.has(name.toLowerCase());
}

export function isCanonicalStake(name: string): boolean {
  return stakeByName.has(name.toLowerCase());
}
