// Per-season capacity helpers. Use these instead of the legacy PLAYERS_PER_DIVISION constant
// when you need the capacity of a specific division (which depends on its season's config).

import { prisma } from "./db.js";
import { PLAYERS_PER_DIVISION } from "./pyramid.js";

export interface SeasonCapacity {
  targetGroupSize: number;
  minGroupSize: number;
}

// Lookup helper — fetches the season for a given division.
export async function capacityForDivision(divisionId: string): Promise<SeasonCapacity> {
  const div = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { season: { select: { targetGroupSize: true, minGroupSize: true } } },
  });
  if (!div) return { targetGroupSize: PLAYERS_PER_DIVISION, minGroupSize: 3 };
  return { targetGroupSize: div.season.targetGroupSize, minGroupSize: div.season.minGroupSize };
}

export function capacityForSeason(season: { targetGroupSize: number; minGroupSize: number }): SeasonCapacity {
  return { targetGroupSize: season.targetGroupSize, minGroupSize: season.minGroupSize };
}
