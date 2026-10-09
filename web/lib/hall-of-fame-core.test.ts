import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { titleCounts, type TitleCountSubject } from "./hall-of-fame-core.js";

describe("titleCounts -- table-driven scenarios", () => {
  it("empty input gives an empty map", () => {
    expect(titleCounts([])).toEqual(new Map());
  });

  it("one champion, one title", () => {
    expect(titleCounts([{ playerId: "p1" }])).toEqual(new Map([["p1", 1]]));
  });

  it("the same player winning three seasons counts three titles", () => {
    const champions = [{ playerId: "p1" }, { playerId: "p1" }, { playerId: "p1" }];
    expect(titleCounts(champions)).toEqual(new Map([["p1", 3]]));
  });

  it("different champions each get their own count", () => {
    const champions = [{ playerId: "p1" }, { playerId: "p2" }, { playerId: "p1" }];
    expect(titleCounts(champions)).toEqual(
      new Map([
        ["p1", 2],
        ["p2", 1],
      ]),
    );
  });

  it("a player absent from the input is absent from the map (not zero)", () => {
    const counts = titleCounts([{ playerId: "p1" }]);
    expect(counts.has("p2")).toBe(false);
    expect(counts.get("p2")).toBeUndefined();
  });
});

describe("titleCounts -- properties", () => {
  const subjectArb: fc.Arbitrary<TitleCountSubject> = fc.record({
    playerId: fc.constantFrom("p1", "p2", "p3", "p4", "p5"),
  });

  it("conservation: the sum of every count equals the number of champions", () => {
    fc.assert(
      fc.property(fc.array(subjectArb, { maxLength: 30 }), (champions) => {
        const counts = titleCounts(champions);
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        expect(total).toBe(champions.length);
      }),
    );
  });

  it("every count is at least 1 -- no player is ever recorded at zero", () => {
    fc.assert(
      fc.property(fc.array(subjectArb, { maxLength: 30 }), (champions) => {
        const counts = titleCounts(champions);
        expect([...counts.values()].every((n) => n >= 1)).toBe(true);
      }),
    );
  });

  it("order-independence: shuffling the input gives the same map", () => {
    fc.assert(
      fc.property(fc.array(subjectArb, { maxLength: 30 }), fc.integer(), (champions, seed) => {
        const shuffled = shuffle(champions, seed);
        expect(titleCounts(shuffled)).toEqual(titleCounts(champions));
      }),
    );
  });

  it("the set of keys equals the set of distinct playerIds in the input", () => {
    fc.assert(
      fc.property(fc.array(subjectArb, { maxLength: 30 }), (champions) => {
        const counts = titleCounts(champions);
        const distinctIds = new Set(champions.map((c) => c.playerId));
        expect(new Set(counts.keys())).toEqual(distinctIds);
      }),
    );
  });
});

// Deterministic Fisher-Yates using a seeded LCG -- fast-check's shrinker needs
// a pure, repeatable shuffle, not Math.random().
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
