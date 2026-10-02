import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeUnplayedPairs, pairKey, type UnplayedPairMember } from "./unplayed-pairs.js";

function membersOf(n: number): UnplayedPairMember<string>[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, data: `p${i}` }));
}

describe("pairKey", () => {
  it("is order-independent", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(pairKey(a, b)).toBe(pairKey(b, a));
      }),
    );
  });
});

describe("computeUnplayedPairs", () => {
  it("every returned pair's key is NOT in playedKeys", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.array(fc.tuple(fc.nat({ max: 11 }), fc.nat({ max: 11 })), { maxLength: 30 }),
        (n, playedPairs) => {
          const members = membersOf(n);
          const playedKeys = new Set(
            playedPairs
              .filter(([i, j]) => i < n && j < n && i !== j)
              .map(([i, j]) => pairKey(`p${i}`, `p${j}`)),
          );
          const result = computeUnplayedPairs({
            activeMembers: members,
            playedKeys,
            scheduleLocked: false,
            assignedKeys: new Set(),
          });
          for (const { a, b } of result) {
            expect(playedKeys.has(pairKey(a, b))).toBe(false);
          }
        },
      ),
    );
  });

  it("a played pair never appears in the unplayed list, regardless of lock state", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), fc.boolean(), (n, scheduleLocked) => {
        const members = membersOf(n);
        // Mark every pair as played — the unplayed list must be empty.
        const playedKeys = new Set<string>();
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) playedKeys.add(pairKey(`p${i}`, `p${j}`));
        }
        const result = computeUnplayedPairs({
          activeMembers: members,
          playedKeys,
          scheduleLocked,
          assignedKeys: playedKeys, // irrelevant when everything's played
        });
        expect(result).toHaveLength(0);
      }),
    );
  });

  it("unlocked: returns exactly the full round-robin minus played pairs", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), (n) => {
        const members = membersOf(n);
        const result = computeUnplayedPairs({
          activeMembers: members,
          playedKeys: new Set(),
          scheduleLocked: false,
          assignedKeys: new Set(),
        });
        expect(result).toHaveLength((n * (n - 1)) / 2);
      }),
    );
  });

  it("locked: an unplayed pair not on the schedule is excluded", () => {
    const members = membersOf(3); // p0, p1, p2
    const result = computeUnplayedPairs({
      activeMembers: members,
      playedKeys: new Set(),
      scheduleLocked: true,
      assignedKeys: new Set([pairKey("p0", "p1")]), // only this pair is scheduled
    });
    expect(result).toEqual([{ a: "p0", b: "p1" }]);
  });
});
