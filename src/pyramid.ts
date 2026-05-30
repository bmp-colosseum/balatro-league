// Canonical league pyramid shape. Tweak here if the structure changes (e.g. an extra Rare division).
import type { Rarity } from "@prisma/client";

export interface PyramidSlot {
  rarity: Rarity;
  groupNumber: number;
  name: string;
}

export const DEFAULT_PYRAMID: Readonly<PyramidSlot[]> = buildPyramid({
  LEGENDARY: 1,
  RARE: 4,
  UNCOMMON: 6,
  COMMON: 6,
});

export const PLAYERS_PER_DIVISION = 5;

export function buildPyramid(counts: Record<Rarity, number>): PyramidSlot[] {
  const slots: PyramidSlot[] = [];
  const order: Rarity[] = ["LEGENDARY", "RARE", "UNCOMMON", "COMMON"];
  for (const rarity of order) {
    const n = counts[rarity] ?? 0;
    for (let i = 1; i <= n; i++) {
      const label = titleCase(rarity);
      const name = n === 1 ? label : `${label} ${i}`;
      slots.push({ rarity, groupNumber: i, name });
    }
  }
  return slots;
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
