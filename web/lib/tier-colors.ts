// Position-based palette for tier pills. Cycles through the legendary/rare/uncommon/common
// colors so custom tier names beyond the default 4 still get sensible colors.

const PALETTE = [
  { bg: "rgba(241, 196, 15, 0.2)", fg: "#f1c40f" },   // gold
  { bg: "rgba(155, 89, 182, 0.2)", fg: "#c79be1" },   // purple
  { bg: "rgba(52, 152, 219, 0.2)", fg: "#76c7ff" },   // blue
  { bg: "rgba(149, 165, 166, 0.2)", fg: "#c0c8cb" },  // grey
] as const;

export function tierColors(position: number): { bg: string; fg: string } {
  const idx = (position - 1) % PALETTE.length;
  return PALETTE[idx]!;
}

// Same cycle as tierColors, exposed as a plain 0-3 index so callers can key
// off it instead of a color pair -- used to attach a stable `data-rarity`
// attribute to tier-pill markup, which the v2 "Card Table" stylesheet maps
// onto the Balatro rarity colors (0 legendary, 1 rare, 2 uncommon, 3 common).
// Pure + separate from tierColors so a v2-aware caller doesn't need the v1
// color pair at all.
export function rarityIndex(position: number): number {
  return (position - 1) % PALETTE.length;
}
