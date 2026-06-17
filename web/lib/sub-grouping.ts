// Balanced sub-grouping for a division.
//
// A division is the competitive unit (standings + promotion run across ALL of
// its members), but each player only plays a fixed number of matches. We split
// the division into sub-groups and each player round-robins WITHIN their
// sub-group, so a sub-group of `groupSize` gives everyone `groupSize - 1`
// matches (5 → 4).
//
// The catch (and the whole reason this isn't a naive top-N chunk): because
// promotion is division-wide but you only play your sub-group, the sub-group IS
// your entire strength-of-schedule. If we chunked by seed (top 5 / mid 5 /
// bottom 5) the bottom group would farm wins off each other while the top group
// ate itself — unfair when they're ranked together. So we snake-distribute by
// seed: each sub-group becomes a representative slice with ≈equal average seed,
// keeping strength-of-schedule even across the whole division.

export interface SubGroupResult {
  // 1-based sub-group index per input member, in the SAME order as the input.
  groups: number[];
  groupCount: number;
}

// `seedOrderedMemberIds` must be sorted strongest-first (seed rank ascending).
// Returns the 1-based sub-group index for each, snake-distributed for balance.
export function balanceSubGroups(seedOrderedMemberIds: string[], groupSize: number): SubGroupResult {
  const n = seedOrderedMemberIds.length;
  const size = Math.max(2, Math.floor(groupSize));
  if (n === 0) return { groups: [], groupCount: 0 };

  // Nearest whole number of groups to the target size — so 15/5 = 3 exactly,
  // 13/5 = 3 (sizes 5/4/4), 7/5 = 1 (a single group of 7) only when rounding
  // says so. At least one group.
  const groupCount = Math.max(1, Math.round(n / size));

  const groups = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const cycle = Math.floor(i / groupCount);
    const pos = i % groupCount;
    // Serpentine: even passes go 0→last, odd passes reverse, so consecutive
    // seeds land in different groups and each group gets a spread of strengths.
    const g = cycle % 2 === 0 ? pos : groupCount - 1 - pos;
    groups[i] = g + 1;
  }
  return { groups, groupCount };
}

// Expected league matches in a division = sum of each sub-group's round-robin
// (C(size,2)). A division that isn't sub-grouped is just one "group" of N.
// Replaces the old N*(N-1)/2 everywhere, which over-counted once we stopped
// having everyone play everyone.
export function expectedMatchesFromGroupSizes(groupSizes: number[]): number {
  return groupSizes.reduce((sum, n) => sum + (n < 2 ? 0 : (n * (n - 1)) / 2), 0);
}

// Sub-group sizes from a division's members. If anyone is assigned a sub-group,
// returns the size of each group (ungrouped stragglers contribute no matches);
// otherwise [N] — the whole division as one round-robin (legacy behavior).
export function groupSizesFromMembers(members: { assignmentGroup: number | null }[]): number[] {
  const subGrouped = members.some((m) => m.assignmentGroup != null);
  if (!subGrouped) return [members.length];
  const counts = new Map<number, number>();
  for (const m of members) {
    if (m.assignmentGroup == null) continue;
    counts.set(m.assignmentGroup, (counts.get(m.assignmentGroup) ?? 0) + 1);
  }
  return [...counts.values()];
}

export interface GroupBalance {
  group: number;
  size: number;
  avgSeed: number; // mean seed rank — groups should be close to each other
  // Matches each member of this group will get under round-robin (size - 1).
  // Flagged for the admin preview when it isn't the target.
  matchesPerPlayer: number;
}

// Per-group balance signals for the admin preview: size, average seed, and how
// many matches each member ends up with. `seeds[i]` is the seed rank of the
// member at index i (same order as the ids passed to balanceSubGroups).
export function summariseBalance(groups: number[], seeds: number[]): GroupBalance[] {
  const byGroup = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(seeds[i]!);
  }
  return [...byGroup.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([group, gs]) => ({
      group,
      size: gs.length,
      avgSeed: gs.reduce((s, x) => s + x, 0) / gs.length,
      matchesPerPlayer: gs.length - 1,
    }));
}
