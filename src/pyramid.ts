// Tier + division template for new seasons.
//
// A season has N tiers (ordered by position 1..N, where 1 = top of the pyramid).
// Each tier has 1+ divisions. Default structure is the joker-rarity pyramid but
// admins can fully customize per-season at creation time.

export interface TierConfig {
  name: string;
  divisionCount: number;
}

export const DEFAULT_TIERS: TierConfig[] = [
  { name: "Legendary", divisionCount: 1 },
  { name: "Rare", divisionCount: 4 },
  { name: "Uncommon", divisionCount: 6 },
  { name: "Common", divisionCount: 6 },
];

export const PLAYERS_PER_DIVISION = 5;

// Parse a textarea-style tier config:
//   Legendary, 1
//   Rare, 4
//   Uncommon, 6
//   Common, 6
// Returns the parsed list (or the default if input is empty/invalid).
export function parseTierConfig(text: string | null | undefined): TierConfig[] {
  if (!text || !text.trim()) return DEFAULT_TIERS;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return DEFAULT_TIERS;

  const out: TierConfig[] = [];
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    const name = parts[0];
    const count = parseInt(parts[1] ?? "1", 10);
    if (!name || Number.isNaN(count) || count < 1) continue;
    out.push({ name, divisionCount: Math.min(count, 50) });
  }
  return out.length > 0 ? out : DEFAULT_TIERS;
}

// Compose the default tier config as a textarea-friendly string.
export function tiersToText(tiers: TierConfig[]): string {
  return tiers.map((t) => `${t.name}, ${t.divisionCount}`).join("\n");
}

// Generate display names for divisions in a tier. Card-themed: the first
// (strongest) division is the Ace ("Rare A"), then 2, 3, 4, 5… A single-
// division tier is just the tier name ("Legendary").
export function defaultDivisionNames(tier: TierConfig): string[] {
  if (tier.divisionCount === 1) return [tier.name];
  return Array.from({ length: tier.divisionCount }, (_, i) => `${tier.name} ${i === 0 ? "A (1)" : i + 1}`);
}
