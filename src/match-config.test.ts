// Tests for generatePool's combo-exclusion behavior — the Bo5 "no repeats"
// rule support. excludeDecks (deck-name variety across games) already had
// implicit coverage via the match-buttons flows; these focus on the newer
// excludeCombos param: exact deck+stake combos that were actually PLAYED
// get hard-dropped from later pools, with a starvation fallback so the
// final 2-combo pick never runs dry.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { generatePool, type DeckEntry } from "./match-config.js";

// Small deterministic PRNG (mulberry32) so tests are reproducible without
// depending on Math.random. Pure function of the seed — same seed, same
// output sequence, every run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const comboKey = (c: DeckEntry): string => `${c.deck}|${c.stake}`;
const sortedKeys = (combos: DeckEntry[]): string[] => combos.map(comboKey).sort();

// 5 decks x 5 stakes = 25 combos — comfortably large so excluding a handful
// never starves a normal-size pool.
const DECKS = ["Red", "Blue", "Green", "Yellow", "Black"];
const STAKES = ["White", "Green", "Black", "Blue", "Gold"];
const ALL_COMBOS: DeckEntry[] = DECKS.flatMap((deck) => STAKES.map((stake) => ({ deck, stake })));

describe("generatePool — combo exclusion (Bo5 no-repeats)", () => {
  it("never re-includes an excluded exact combo when plenty of combos remain", () => {
    fc.assert(
      fc.property(
        fc.subarray(ALL_COMBOS, { maxLength: 10 }), // 10 of 25 excluded, 15+ always remain
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        (excludeCombos, seed) => {
          const rand = mulberry32(seed);
          const pool = generatePool(DECKS, STAKES, 9, rand, [], excludeCombos);
          const excludedKeys = new Set(excludeCombos.map(comboKey));
          expect(pool.every((c) => !excludedKeys.has(comboKey(c)))).toBe(true);
        },
      ),
    );
  });

  it("excludes only the exact combo, not the whole deck or the whole stake", () => {
    const decks = ["Red", "Blue"];
    const stakes = ["White", "Black"];
    // 4 combos total; excluding one leaves 3, well above the 2-combo floor.
    const pool = generatePool(decks, stakes, 3, mulberry32(42), [], [{ deck: "Red", stake: "White" }]);
    expect(pool).toHaveLength(3);
    expect(sortedKeys(pool)).toEqual(
      sortedKeys([
        { deck: "Red", stake: "Black" },
        { deck: "Blue", stake: "White" },
        { deck: "Blue", stake: "Black" },
      ]),
    );
  });

  it("relaxes the exclusion (pool not starved) when it would leave fewer than 2 combos", () => {
    const decks = ["Red"];
    const stakes = ["White", "Black"]; // only 2 combos exist at all
    const excludeCombos: DeckEntry[] = [
      { deck: "Red", stake: "White" },
      { deck: "Red", stake: "Black" },
    ];
    const pool = generatePool(decks, stakes, 2, mulberry32(7), [], excludeCombos);
    // Both excluded combos come back — otherwise there'd be nothing to pick from.
    expect(pool).toHaveLength(2);
    expect(sortedKeys(pool)).toEqual(sortedKeys(excludeCombos));
  });

  it("is deterministic given the same seeded rand", () => {
    const excludeCombos = [{ deck: "Red", stake: "White" }];
    const poolA = generatePool(DECKS, STAKES, 9, mulberry32(1234), [], excludeCombos);
    const poolB = generatePool(DECKS, STAKES, 9, mulberry32(1234), [], excludeCombos);
    expect(poolB).toEqual(poolA);
  });

  it("still honors excludeDecks (deck-name variety) alongside excludeCombos", () => {
    const excludeCombos = [{ deck: "Blue", stake: "White" }];
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(99), ["Green"], excludeCombos);
    expect(pool.some((c) => c.deck === "Green")).toBe(false);
    expect(pool.some((c) => c.deck === "Blue" && c.stake === "White")).toBe(false);
  });
});
