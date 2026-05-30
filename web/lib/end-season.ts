// Compute new player ratings from final season standings.
//
// Goal: a player's new rating reflects where they finished, in a way that
// naturally drives next-season's auto-seed to do the right thing:
//   - Top finisher of tier T's rating ≈ baseline of tier T-1 → gets promoted
//   - Bottom finisher of tier T's rating ≈ baseline of tier T+1 → gets relegated
//   - Mid-pack ≈ tier baseline → stays
//
// Algorithm:
//   tier baseline:  linear from TOP_BASELINE (tier 1) to BOTTOM_BASELINE (tier N)
//   in-tier adjust: linear from +TIER_GAP/2 (1st place) to -TIER_GAP/2 (last place)
//   new_rating = round(baseline + adjustment)
//
// Dropped players keep their current rating (no penalty for quitting mid-season).

import type { StandingRow } from "./standings";

const TOP_BASELINE = 1000;
const BOTTOM_BASELINE = 200;

export interface DivisionForRating {
  tierPosition: number; // 1 = top
  members: Array<{ playerId: string; status: "ACTIVE" | "DROPPED"; currentRating: number | null }>;
  standings: StandingRow[]; // already sorted; same Player ids as members
}

export interface RatingDelta {
  playerId: string;
  displayName: string;
  oldRating: number | null;
  newRating: number;
  delta: number;
  tierPosition: number;
  finishPosition: number; // 1-indexed within division
  divisionSize: number;
}

export function computeRatingDeltas(
  numTiers: number,
  divisions: DivisionForRating[],
): RatingDelta[] {
  if (numTiers < 1) return [];
  const tierGap = numTiers > 1 ? (TOP_BASELINE - BOTTOM_BASELINE) / (numTiers - 1) : 0;

  function baselineFor(tierPosition: number): number {
    if (numTiers === 1) return TOP_BASELINE;
    return TOP_BASELINE - ((tierPosition - 1) / (numTiers - 1)) * (TOP_BASELINE - BOTTOM_BASELINE);
  }

  const out: RatingDelta[] = [];

  for (const div of divisions) {
    const baseline = baselineFor(div.tierPosition);
    const droppedSet = new Set(
      div.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
    );
    const oldRatingByPlayer = new Map(div.members.map((m) => [m.playerId, m.currentRating]));

    // Only ACTIVE players factor into the in-tier ranking. Their finish
    // position is their index in the standings.
    const activeStandings = div.standings.filter((row) => !droppedSet.has(row.player.id));
    const M = activeStandings.length;

    activeStandings.forEach((row, idx) => {
      // i=0 (top): +tierGap/2 ; i=M-1 (bottom): -tierGap/2
      let adjustment: number;
      if (M === 1) {
        adjustment = 0;
      } else {
        adjustment = (tierGap / 2) * (1 - (2 * idx) / (M - 1));
      }
      const newRating = Math.max(0, Math.round(baseline + adjustment));
      const oldRating = oldRatingByPlayer.get(row.player.id) ?? null;
      out.push({
        playerId: row.player.id,
        displayName: row.player.displayName,
        oldRating,
        newRating,
        delta: newRating - (oldRating ?? 0),
        tierPosition: div.tierPosition,
        finishPosition: idx + 1,
        divisionSize: M,
      });
    });
  }
  return out;
}
