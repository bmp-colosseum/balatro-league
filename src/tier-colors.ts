// Tier-position accent colors for Discord Components V2 containers. Mirrors the
// Balatro rarity palette web/app/globals.css defines for tier pills (see that
// file's --legendary/--rare/--uncommon/--common custom properties) and the
// cycle web/lib/tier-colors.ts's rarityIndex already uses: tier position 1 is
// the top of the pyramid (legendary), and a season with more than four tiers
// cycles back to legendary rather than running off the palette.
//
// Deliberately duplicated rather than imported -- this bot has no dependency
// on the web app's module graph, and the cycle is one line of pure math.

const PALETTE: readonly number[] = [
  0xbb73d6, // legendary (--legendary)
  0xff6259, // rare (--rare)
  0x3cc78f, // uncommon (--uncommon)
  0x1e9bff, // common (--common)
];

// Used when a division's tier position is missing or out of range -- keeps a
// result post colored instead of falling back to Discord's default grey.
export const FALLBACK_ACCENT_COLOR = 0xf1c40f;

// Same (position - 1) % length cycle as web/lib/tier-colors.ts's rarityIndex,
// exposed here in case a caller wants the raw 0-3 index rather than a color.
export function rarityIndex(position: number): number {
  return (position - 1) % PALETTE.length;
}

// Resolve a Tier.position (1 = top) to the hex accent color for a container.
// Returns the fallback for null/undefined/non-finite/less-than-1 positions
// instead of indexing with a negative or NaN value.
export function tierAccentColor(position: number | null | undefined): number {
  if (position == null || !Number.isFinite(position) || position < 1) return FALLBACK_ACCENT_COLOR;
  const idx = rarityIndex(Math.trunc(position));
  return PALETTE[idx] ?? FALLBACK_ACCENT_COLOR;
}
