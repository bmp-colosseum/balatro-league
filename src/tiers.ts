// Helpers for creating + querying the tier structure of a season.

import { prisma } from "./db.js";
import { defaultDivisionNames, type TierConfig } from "./pyramid.js";
import { tierAccentColor } from "./tier-colors.js";

// Create the Tier rows + per-tier Division rows for a season.
// Called from /league create-season (Discord) and the dashboard create-season POST.
export async function createTiersAndDivisions(seasonId: string, tiers: TierConfig[]): Promise<{ tiersCreated: number; divisionsCreated: number }> {
  let tiersCreated = 0;
  let divisionsCreated = 0;
  for (let i = 0; i < tiers.length; i++) {
    const config = tiers[i]!;
    const tier = await prisma.tier.create({
      data: { seasonId, position: i + 1, name: config.name },
    });
    tiersCreated++;
    const names = defaultDivisionNames(config);
    for (let g = 1; g <= config.divisionCount; g++) {
      await prisma.division.create({
        data: { seasonId, tierId: tier.id, groupNumber: g, name: names[g - 1]! },
      });
      divisionsCreated++;
    }
  }
  return { tiersCreated, divisionsCreated };
}

// Pill color used by the UI based on tier POSITION (1-indexed).
// Cycles through the legendary-rare-uncommon-common palette for the first 4 tiers,
// then loops. Admins can later add a per-tier color field if needed.
const TIER_PALETTE = [
  { bg: "rgba(241, 196, 15, 0.2)", fg: "#f1c40f" },   // gold (Legendary by default)
  { bg: "rgba(155, 89, 182, 0.2)", fg: "#c79be1" },   // purple (Rare)
  { bg: "rgba(52, 152, 219, 0.2)", fg: "#76c7ff" },   // blue (Uncommon)
  { bg: "rgba(149, 165, 166, 0.2)", fg: "#c0c8cb" },  // grey (Common)
] as const;

export function tierColors(position: number): { bg: string; fg: string } {
  const idx = (position - 1) % TIER_PALETTE.length;
  return TIER_PALETTE[idx]!;
}

// Discord embed color for a tier position. Delegates to the one rarity
// palette (tier-colors.ts) the result posts and #league-standings embeds use,
// so /standings, the channel and the website all agree on which tier is
// purple (legendary), red (rare), green (uncommon) and blue (common). The
// old local list here put yellow on the top tier and purple on the second.
export function tierEmbedColor(position: number): number {
  return tierAccentColor(position);
}
