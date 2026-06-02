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
  // Algorithm:
  //   1. Initial rank: sort by (tier asc, divisionGroup asc, finish asc).
  //      Rare 1 takes ranks 7-11, Rare 2 takes 12-16, etc. — the
  //      sequential-fill build flow's inverse, so a player finishing
  //      in the same position in the same division gets the same rank.
  //   2. Promo/relegate chain swap: walk every adjacent division pair
  //      in the chain (Legendary → Rare 1 → Rare 2 → ... → Common 6)
  //      and swap the bottom finisher of the upper division with the
  //      top finisher of the lower division. This is the same promo
  //      (↑ green) / relegate (↓ red) movement shown on /standings —
  //      top of each div promotes to the previous div, bottom of each
  //      div relegates to the next div. Middle players keep their rank.
  //
  // DROPPED players keep their existing rank (no penalty). Ranks are
  // integers 1..N over ACTIVE players only.
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
  entries.sort((a, b) => {
    if (a.tierPosition !== b.tierPosition) return a.tierPosition - b.tierPosition;
    if (a.divisionGroupNumber !== b.divisionGroupNumber) return a.divisionGroupNumber - b.divisionGroupNumber;
    return a.finishPosition - b.finishPosition;
  });

  // playerId → rank (1-based, position in `entries` after initial sort).
  const rankByPlayer = new Map<string, number>();
  entries.forEach((e, i) => rankByPlayer.set(e.playerId, i + 1));

  // Group entries by their division's (tier, group) so we can find
  // top/bottom of each. Insertion order = chain order because `entries`
  // is already sorted by (tier, group, finish).
  const divisionChain: { key: string; players: string[] }[] = [];
  const divKeyIndex = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.tierPosition}:${e.divisionGroupNumber}`;
    let idx = divKeyIndex.get(key);
    if (idx === undefined) {
      idx = divisionChain.length;
      divKeyIndex.set(key, idx);
      divisionChain.push({ key, players: [] });
    }
    divisionChain[idx]!.players.push(e.playerId);
  }

  // For each adjacent pair (A, B) in the chain, swap A's bottom with
  // B's top. Skip pairs where either side has <2 players — there's no
  // meaningful "top + bottom" distinction to swap.
  for (let i = 0; i < divisionChain.length - 1; i++) {
    const a = divisionChain[i]!.players;
    const b = divisionChain[i + 1]!.players;
    if (a.length < 2 || b.length < 2) continue;
    const bottomA = a[a.length - 1]!;
    const topB = b[0]!;
    const rA = rankByPlayer.get(bottomA)!;
    const rB = rankByPlayer.get(topB)!;
    rankByPlayer.set(bottomA, rB);
    rankByPlayer.set(topB, rA);
  }

  return entries.map((e) => {
    const newRating = rankByPlayer.get(e.playerId)!;
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
