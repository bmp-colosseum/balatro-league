import { describe, expect, it } from "vitest";
import { balanceSubGroups, summariseBalance } from "./sub-grouping.js";

// Helper: ids "0".."n-1" in seed order (strongest first).
function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(i));
}

describe("balanceSubGroups", () => {
  it("splits 15 into 3 groups of 5", () => {
    const { groups, groupCount } = balanceSubGroups(ids(15), 5);
    expect(groupCount).toBe(3);
    const sizes = [1, 2, 3].map((g) => groups.filter((x) => x === g).length);
    expect(sizes).toEqual([5, 5, 5]);
  });

  it("snake-balances so each group's average seed is near-equal", () => {
    const seeds = Array.from({ length: 15 }, (_, i) => i + 1); // seeds 1..15
    const { groups } = balanceSubGroups(ids(15), 5);
    const bal = summariseBalance(groups, seeds);
    const avgs = bal.map((b) => b.avgSeed);
    // Overall mean is 8; every group should sit within ~1 of it.
    for (const a of avgs) expect(Math.abs(a - 8)).toBeLessThanOrEqual(1);
    // Every player gets 4 matches.
    expect(bal.every((b) => b.matchesPerPlayer === 4)).toBe(true);
  });

  it("a chunk-by-seed split would NOT be balanced (sanity on the snake)", () => {
    // Top-5 chunk would have avg seed 3; snake must beat that spread.
    const seeds = Array.from({ length: 15 }, (_, i) => i + 1);
    const { groups } = balanceSubGroups(ids(15), 5);
    const bal = summariseBalance(groups, seeds);
    const spread = Math.max(...bal.map((b) => b.avgSeed)) - Math.min(...bal.map((b) => b.avgSeed));
    expect(spread).toBeLessThan(2); // chunked spread would be ~10
  });

  it("handles uneven counts (13 → 3 groups, sizes within 1)", () => {
    const { groups, groupCount } = balanceSubGroups(ids(13), 5);
    expect(groupCount).toBe(3);
    const sizes = [1, 2, 3].map((g) => groups.filter((x) => x === g).length).sort();
    expect(sizes).toEqual([4, 4, 5]);
  });

  it("keeps a small division as a single round-robin group", () => {
    const { groups, groupCount } = balanceSubGroups(ids(5), 5);
    expect(groupCount).toBe(1);
    expect(groups.every((g) => g === 1)).toBe(true);
  });

  it("returns empty for an empty division", () => {
    expect(balanceSubGroups([], 5)).toEqual({ groups: [], groupCount: 0 });
  });
});
