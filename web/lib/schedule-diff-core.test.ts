import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { diffOpponents, type Pairing } from "./schedule-diff-core.js";

describe("diffOpponents", () => {
  it("no change -> empty diff", () => {
    const before: Pairing[] = [
      { playerAId: "p1", playerBId: "p2" },
      { playerAId: "p2", playerBId: "p3" },
    ];
    const after: Pairing[] = [
      { playerAId: "p1", playerBId: "p2" },
      { playerAId: "p2", playerBId: "p3" },
    ];
    expect(diffOpponents(before, after)).toEqual([]);
  });

  it("one new opponent added", () => {
    const before: Pairing[] = [{ playerAId: "p1", playerBId: "p2" }];
    const after: Pairing[] = [
      { playerAId: "p1", playerBId: "p2" },
      { playerAId: "p1", playerBId: "p3" },
    ];
    expect(diffOpponents(before, after)).toEqual([
      { playerId: "p1", added: ["p3"], removed: [] },
      { playerId: "p3", added: ["p1"], removed: [] },
    ]);
  });

  it("one swapped opponent -- added and removed on both sides", () => {
    const before: Pairing[] = [{ playerAId: "p1", playerBId: "p2" }];
    const after: Pairing[] = [{ playerAId: "p1", playerBId: "p3" }];
    expect(diffOpponents(before, after)).toEqual([
      { playerId: "p1", added: ["p3"], removed: ["p2"] },
      { playerId: "p2", added: [], removed: ["p1"] },
      { playerId: "p3", added: ["p1"], removed: [] },
    ]);
  });

  it("a player who left the division loses every opponent", () => {
    const before: Pairing[] = [
      { playerAId: "p1", playerBId: "p2" },
      { playerAId: "p1", playerBId: "p3" },
    ];
    const after: Pairing[] = [{ playerAId: "p2", playerBId: "p3" }];
    expect(diffOpponents(before, after)).toEqual([
      { playerId: "p1", added: [], removed: ["p2", "p3"] },
      { playerId: "p2", added: ["p3"], removed: ["p1"] },
      { playerId: "p3", added: ["p2"], removed: ["p1"] },
    ]);
  });

  it("a player who joined the division gains every opponent", () => {
    const before: Pairing[] = [{ playerAId: "p2", playerBId: "p3" }];
    const after: Pairing[] = [
      { playerAId: "p1", playerBId: "p2" },
      { playerAId: "p1", playerBId: "p3" },
      { playerAId: "p2", playerBId: "p3" },
    ];
    expect(diffOpponents(before, after)).toEqual([
      { playerId: "p1", added: ["p2", "p3"], removed: [] },
      { playerId: "p2", added: ["p1"], removed: [] },
      { playerId: "p3", added: ["p1"], removed: [] },
    ]);
  });

  it("is independent of pairing order in the input lists", () => {
    const beforeA: Pairing[] = [
      { playerAId: "p1", playerBId: "p2" },
      { playerAId: "p2", playerBId: "p3" },
    ];
    const beforeB = [...beforeA].reverse();
    const after: Pairing[] = [{ playerAId: "p1", playerBId: "p3" }];
    expect(diffOpponents(beforeA, after)).toEqual(diffOpponents(beforeB, after));
  });

  it("duplicate pairings (same unordered pair repeated) are ignored", () => {
    const before: Pairing[] = [{ playerAId: "p1", playerBId: "p2" }];
    const afterDup: Pairing[] = [
      { playerAId: "p1", playerBId: "p2" },
      { playerAId: "p2", playerBId: "p1" }, // same pair, reversed
      { playerAId: "p1", playerBId: "p2" }, // exact duplicate
    ];
    expect(diffOpponents(before, afterDup)).toEqual([]);
  });

  // Arbitrary pair of distinct player ids out of a small pool (p0..p8),
  // built via .map() rather than .filter() so generation/shrinking stays
  // efficient -- offset in [1,8] mod 9 guarantees a !== b without discarding.
  const distinctPairArb = fc
    .tuple(fc.nat({ max: 8 }), fc.integer({ min: 1, max: 8 }))
    .map(([a, offset]): [number, number] => [a, (a + offset) % 9]);
  const pairingsArb = fc
    .array(distinctPairArb, { maxLength: 20 })
    .map((pairs) => pairs.map(([a, b]) => ({ playerAId: `p${a}`, playerBId: `p${b}` })));

  it("property: a player never appears in both added and removed", () => {
    fc.assert(
      fc.property(pairingsArb, pairingsArb, (before, after) => {
        const diffs = diffOpponents(before, after);
        for (const d of diffs) {
          const overlap = d.added.filter((id) => d.removed.includes(id));
          expect(overlap).toEqual([]);
        }
      }),
    );
  });

  it("property: diffing a pairing list against itself is always empty", () => {
    fc.assert(
      fc.property(pairingsArb, (pairings) => {
        expect(diffOpponents(pairings, pairings)).toEqual([]);
      }),
    );
  });
});
