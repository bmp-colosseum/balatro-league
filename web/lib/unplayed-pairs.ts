// Pure core for the /divisions/[id] "unplayed matchups" list. Zero imports —
// colocated test runs under the root vitest project (see vitest.config.ts's
// `include: ["web/lib/**/*.test.ts"]`).
//
// Given the active members of a division plus which pairs have already been
// played (and, for a locked schedule, which pairs are actually assigned),
// returns every pair that's still outstanding. O(active members squared) is
// inherent — that's the shape of "every unplayed pair" when the format is a
// full round-robin — but membership tests against playedKeys/assignedKeys are
// O(1) Set lookups rather than a second N^2 scan, which is the fix: the
// shell no longer refetches "all matches" just to build this set when the
// division isn't schedule-locked (see loadDivisionPageData).

export interface UnplayedPairMember<T> {
  id: string;
  data: T;
}

// Canonical, order-independent key for an unordered pair of ids.
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export interface ComputeUnplayedPairsInput<T> {
  activeMembers: UnplayedPairMember<T>[];
  // Pair keys (via pairKey) that have already been played/confirmed.
  playedKeys: ReadonlySet<string>;
  // True when this division is on a fixed (locked) schedule — only pairs in
  // assignedKeys count as real matchups; every other not-yet-played pair is
  // just "not scheduled", not "unplayed".
  scheduleLocked: boolean;
  // Pair keys on the pre-created schedule. Ignored when scheduleLocked is false.
  assignedKeys: ReadonlySet<string>;
}

export interface UnplayedPair<T> {
  a: T;
  b: T;
}

export function computeUnplayedPairs<T>({
  activeMembers,
  playedKeys,
  scheduleLocked,
  assignedKeys,
}: ComputeUnplayedPairsInput<T>): UnplayedPair<T>[] {
  const unplayed: UnplayedPair<T>[] = [];
  for (let i = 0; i < activeMembers.length; i++) {
    for (let j = i + 1; j < activeMembers.length; j++) {
      const a = activeMembers[i]!;
      const b = activeMembers[j]!;
      const key = pairKey(a.id, b.id);
      if (playedKeys.has(key)) continue;
      if (scheduleLocked && !assignedKeys.has(key)) continue;
      unplayed.push({ a: a.data, b: b.data });
    }
  }
  return unplayed;
}
