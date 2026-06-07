// Canonical Balatro deck/stake list with effect descriptions. Hard-coded
// (vs DB-stored) because the list is game-truthy + curated by the league
// staff for which mod decks they're allowing, not a per-instance config.
// Update by editing src/data/balatro-info.json and redeploying.
//
// Match-flow UI looks up descriptions to render under each ban-menu option
// and inside the pick-step embed. Deck/stake preset editor populates its
// 'Add' dropdowns from this list so admin can't typo a name into existence.

import info from "./data/balatro-info.json" with { type: "json" };

export interface BalatroItem {
  name: string;
  description: string;
  // Optional unicode-emoji fallback for items with no PNG art (e.g. the
  // custom multiplayer-mod stakes before their chip emoji is uploaded).
  emoji?: string;
}

export const CANONICAL_DECKS: readonly BalatroItem[] = info.decks;
export const CANONICAL_STAKES: readonly BalatroItem[] = info.stakes;

const deckByName = new Map(CANONICAL_DECKS.map((d) => [d.name.toLowerCase(), d]));
const stakeByName = new Map(CANONICAL_STAKES.map((s) => [s.name.toLowerCase(), s]));
// Position in the canonical list — used to sort UI displays (ban menu,
// pick step, preset editor) so decks always appear A-Z and stakes always
// appear in difficulty order regardless of how the random pool was
// shuffled. Returns Number.MAX_SAFE_INTEGER for non-canonical names so
// they sink to the bottom of any sort.
const deckPos = new Map(CANONICAL_DECKS.map((d, i) => [d.name.toLowerCase(), i]));
const stakePos = new Map(CANONICAL_STAKES.map((s, i) => [s.name.toLowerCase(), i]));

export function deckDescription(name: string): string | undefined {
  return deckByName.get(name.toLowerCase())?.description;
}

export function stakeDescription(name: string): string | undefined {
  return stakeByName.get(name.toLowerCase())?.description;
}

// Unicode-emoji fallback for a stake (only set for custom stakes without PNG
// art). Used when no uploaded Discord emoji exists yet.
export function stakeEmojiChar(name: string): string | undefined {
  return stakeByName.get(name.toLowerCase())?.emoji;
}

export function canonicalDeckIndex(name: string): number {
  return deckPos.get(name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
}

export function canonicalStakeIndex(name: string): number {
  return stakePos.get(name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
}

export function isCanonicalDeck(name: string): boolean {
  return deckByName.has(name.toLowerCase());
}

export function isCanonicalStake(name: string): boolean {
  return stakeByName.has(name.toLowerCase());
}

// Lowercase, alphanumeric+underscore slug used for asset filenames and
// Discord application emoji names. "Red Deck" → "red", "Magic" → "magic".
export function deckSlug(name: string): string {
  return name.toLowerCase().replace(/\+/g, "_plus").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function stakeSlug(name: string): string {
  return name.toLowerCase().replace(/\+/g, "_plus").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
