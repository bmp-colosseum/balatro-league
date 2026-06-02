// End-of-season rank computation. Replaces the previous tier-baseline
// math with a simple global rank: the strongest player league-wide
// gets rank 1, the weakest gets rank N. Next season's build sorts
// by rank ASC so rank 1 lands in the top tier, etc — produces the
// same tier movement as the old algorithm without the baseline magic.
//
// Sort key (best → worst):
//   1. Tier position (lower = better tier — Legendary first)
//   2. Within tier: finishing position in division (1 first)
//
// DROPPED players keep their existing rank (no penalty). Ranks are
// integers 1..N over ACTIVE players only.

import type { StandingRow } from "./standings";

export interface DivisionForRating {
  tierPosition: number; // 1 = top tier
  // Within-tier ordering (1-based). Optional — falls back to the array
  // position in `divisions` when not supplied.
  divisionGroupNumber?: number;
  members: Array<{ playerId: string; status: "ACTIVE" | "DROPPED"; currentRating: number | null }>;
  standings: StandingRow[];
}

export interface RatingDelta {
  playerId: string;
  displayName: string;
  oldRating: number | null;
  newRating: number;
  delta: number;
  tierPosition: number;
  finishPosition: number;
  divisionSize: number;
}

export function computeRatingDeltas(
  numTiers: number,
  divisions: DivisionForRating[],
): RatingDelta[] {
  void numTiers;
  // Stable per-division ordering: each (tier, division, finish-position)
  // triple maps to one rank. NO interleaving across divisions within a
  // tier — Rare 1's top finisher gets rank 7, all of Rare 1 ranks 7-12,
  // then Rare 2 ranks 13-18, etc. This keeps ranks stable year-over-
  // year if a player finishes in the same position in the same
  // division.
  //
  // Promotion / relegation is implicit:
  //   - Top finishers naturally get the LOWEST rank within their
  //     tier's range (closest to the tier above)
  //   - Bottom finishers naturally get the HIGHEST rank within their
  //     tier's range (closest to the tier below)
  // When next season's planByRating sorts by rank ASC, the boundary
  // players are positioned to be picked up by adjacent tiers in the
  // build flow — admin can drag the rest as needed.
  interface FlatEntry {
    playerId: string;
    displayName: string;
    oldRating: number | null;
    tierPosition: number;
    divisionGroupNumber: number;
    finishPosition: number;
    divisionSize: number;
  }
  const entries: FlatEntry[] = [];
  divisions.forEach((div, divIdx) => {
    const droppedSet = new Set(
      div.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
    );
    const oldByPlayer = new Map(div.members.map((m) => [m.playerId, m.currentRating]));
    const active = div.standings.filter((row) => !droppedSet.has(row.player.id));
    // Fallback to array index if groupNumber wasn't supplied — at least
    // gives a stable per-call ordering.
    const groupNumber = div.divisionGroupNumber ?? divIdx + 1;
    active.forEach((row, idx) => {
      entries.push({
        playerId: row.player.id,
        displayName: row.player.displayName,
        oldRating: oldByPlayer.get(row.player.id) ?? null,
        tierPosition: div.tierPosition,
        divisionGroupNumber: groupNumber,
        finishPosition: idx + 1,
        divisionSize: active.length,
      });
    });
  });
  // Sort: tier asc → division group asc → finish asc.
  entries.sort((a, b) => {
    if (a.tierPosition !== b.tierPosition) return a.tierPosition - b.tierPosition;
    if (a.divisionGroupNumber !== b.divisionGroupNumber) return a.divisionGroupNumber - b.divisionGroupNumber;
    return a.finishPosition - b.finishPosition;
  });
  return entries.map((e, i) => {
    const newRating = i + 1;
    return {
      playerId: e.playerId,
      displayName: e.displayName,
      oldRating: e.oldRating,
      newRating,
      delta: newRating - (e.oldRating ?? 0),
      tierPosition: e.tierPosition,
      finishPosition: e.finishPosition,
      divisionSize: e.divisionSize,
    };
  });
}
