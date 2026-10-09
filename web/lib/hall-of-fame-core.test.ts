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

describe("titleCounts -- division-title counting (v2 trophy shelf)", () => {
  // Same function, different subject list: the loader flattens EVERY
  // division's champion across EVERY ended season (not just the top
  // division) and calls titleCounts over that instead of the league-champion
  // list -- these scenarios exercise that shape directly so a future change
  // to titleCounts can't silently break the division-title use case while
  // the league-title tests above stay green.

  it("a player who wins the same division in two different seasons gets 2 division titles", () => {
    // e.g. "Rare 2" champion in Season 7 and again in Season 8.
    const divisionChampions = [
      { playerId: "p1" }, // Season 7, Rare 2
      { playerId: "p1" }, // Season 8, Rare 2
    ];
    expect(titleCounts(divisionChampions)).toEqual(new Map([["p1", 2]]));
  });

  it("a player who wins DIFFERENT divisions in different seasons still accumulates one combined count", () => {
    // e.g. promoted from "Common 1" in Season 7 to "Rare 1" in Season 8 --
    // titleCounts only reads playerId, so the division/tier identity of each
    // win is irrelevant to the tally.
    const divisionChampions = [
      { playerId: "p1" }, // Season 7, Common 1
      { playerId: "p1" }, // Season 8, Rare 1
    ];
    expect(titleCounts(divisionChampions)).toEqual(new Map([["p1", 2]]));
  });

  it("one season's full ladder of division champions counts each distinct winner once", () => {
    // A single ended season with e.g. 15 division champions (Season 8's
    // ladder), all first-time winners -- every count is exactly 1.
    const divisionChampions = Array.from({ length: 15 }, (_, i) => ({ playerId: `p${i + 1}` }));
    const counts = titleCounts(divisionChampions);
    expect(counts.size).toBe(15);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("per-player counting is independent across seasons: a repeat division champion mixed with a full season of first-timers", () => {
    const divisionChampions = [
      { playerId: "p1" }, // Season 7, Legendary
      { playerId: "p2" }, // Season 7, Rare 1
      { playerId: "p1" }, // Season 8, Legendary (same player, back-to-back)
      { playerId: "p3" }, // Season 8, Rare 1
    ];
    expect(titleCounts(divisionChampions)).toEqual(
      new Map([
        ["p1", 2],
        ["p2", 1],
        ["p3", 1],
      ]),
    );
  });

  it("order-independence holds for a realistic multi-season division-champion list", () => {
    const champions = [{ playerId: "p1" }, { playerId: "p2" }, { playerId: "p1" }, { playerId: "p3" }, { playerId: "p2" }];
    const shuffled = shuffle(champions, 42);
    expect(titleCounts(shuffled)).toEqual(titleCounts(champions));
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
