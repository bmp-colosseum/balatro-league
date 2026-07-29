// Tests for generatePool's combo-exclusion behavior — the Bo5 "no repeats"
// rule support. excludeDecks (deck-name variety across games) already had
// implicit coverage via the match-buttons flows; these focus on the newer
// excludeCombos param: exact deck+stake combos that were actually PLAYED
// get hard-dropped from later pools, with a starvation fallback so the
// final 2-combo pick never runs dry.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  generatePool,
  checkPoolPolicyFeasibility,
  enabledDecksFor,
  enabledStakesFor,
  BMP_POOL,
  type DeckEntry,
  type DeckWeight,
  type StakeWeight,
  type GuaranteedStake,
  type PoolPolicy,
} from "./match-config.js";

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

// Tests for the BMP-style bans extension: deckWeights + poolPolicy, ported
// from balatro-team-tour's match-pool.test.ts. The unpolicied path (no
// weights, no policy) must stay byte-for-byte identical to the pre-existing
// behavior -- every current caller (random.ts, pool.ts, and non-BMP matches
// in match-buttons.ts) passes no weights/policy and must be unaffected.
describe("generatePool -- BMP-style bans: byte-compat of the unpolicied path", () => {
  it("an explicitly empty deckWeights + poolPolicy is IDENTICAL to omitting them", () => {
    const a = generatePool(DECKS, STAKES, 9, mulberry32(4242));
    const b = generatePool(DECKS, STAKES, 9, mulberry32(4242), [], [], [], {});
    expect(b).toEqual(a);
  });

  it("pins the exact output of an unconfigured call for a fixed seed -- must never change", () => {
    // Regression pin: captured once from generatePool's own output (no
    // weights, no policy). If this ever needs to change, the "uniform
    // behavior is the DEFAULT" byte-compat promise has been broken and
    // every existing caller's pools would shift.
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(4242));
    expect(pool).toEqual([
      { deck: "Blue", stake: "Blue" },
      { deck: "Red", stake: "Black" },
      { deck: "Black", stake: "Gold" },
      { deck: "Black", stake: "Blue" },
      { deck: "Yellow", stake: "Green" },
      { deck: "Red", stake: "White" },
      { deck: "Yellow", stake: "Blue" },
      { deck: "Red", stake: "Green" },
      { deck: "Yellow", stake: "White" },
    ]);
  });
});

describe("checkPoolPolicyFeasibility", () => {
  it("is feasible for a comfortably-sized policy", () => {
    const result = checkPoolPolicyFeasibility(DECKS, STAKES, 9, [], {
      maxPerDeck: 3,
      maxPerStake: 4,
      guaranteedStakes: [{ stake: "White", min: 1 }],
    });
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it("flags a maxPerStake cap too tight to fill the pool, with the specific reason", () => {
    const result = checkPoolPolicyFeasibility(DECKS, STAKES, 9, [], { maxPerStake: 1 });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("5 stakes at max 1 each cannot fill a pool of 9"))).toBe(true);
  });

  it("flags a maxPerDeck cap too tight to fill the pool", () => {
    const result = checkPoolPolicyFeasibility(DECKS, ["White"], 9, [], { maxPerDeck: 1 });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes(`${DECKS.length} decks at max 1 each cannot fill a pool of 9`))).toBe(
      true,
    );
  });

  it("flags guarantees summing past the pool size", () => {
    const guaranteedStakes: GuaranteedStake[] = [
      { stake: "White", min: 5 },
      { stake: "Green", min: 5 },
    ];
    const result = checkPoolPolicyFeasibility(DECKS, STAKES, 9, [], { guaranteedStakes });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("total 10, more than the pool size of 9"))).toBe(true);
  });

  it("flags a guarantee for a stake that isn't enabled", () => {
    const stakeWeights: StakeWeight[] = [{ stake: "White", weight: 0 }];
    const result = checkPoolPolicyFeasibility(DECKS, STAKES, 4, [], {
      stakeWeights,
      guaranteedStakes: [{ stake: "White", min: 1 }],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('"White" is not enabled'))).toBe(true);
  });

  it("flags a guarantee whose min exceeds its own maxPerStake cap", () => {
    const result = checkPoolPolicyFeasibility(DECKS, STAKES, 8, [], {
      maxPerStake: 2,
      guaranteedStakes: [{ stake: "White", min: 3 }],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("exceeds its own maxPerStake cap of 2"))).toBe(true);
  });
});

describe("generatePool -- BMP-style bans: pool policy", () => {
  it("never exceeds maxPerDeck", () => {
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(1), [], [], [], { maxPerDeck: 2 });
    const counts = new Map<string, number>();
    for (const c of pool) counts.set(c.deck, (counts.get(c.deck) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(2);
    expect(pool).toHaveLength(9);
  });

  it("never exceeds maxPerStake", () => {
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(2), [], [], [], { maxPerStake: 2 });
    const counts = new Map<string, number>();
    for (const c of pool) counts.set(c.stake, (counts.get(c.stake) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(2);
    expect(pool).toHaveLength(9);
  });

  it("meets every guaranteed stake minimum", () => {
    const guaranteedStakes: GuaranteedStake[] = [
      { stake: "White", min: 2 },
      { stake: "Black", min: 1 },
    ];
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(3), [], [], [], { guaranteedStakes });
    const counts = new Map<string, number>();
    for (const c of pool) counts.set(c.stake, (counts.get(c.stake) ?? 0) + 1);
    expect(counts.get("White") ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.get("Black") ?? 0).toBeGreaterThanOrEqual(1);
    expect(pool).toHaveLength(9);
  });

  it("merges duplicate guarantees for the same stake to their MAX, not their sum", () => {
    const guaranteedStakes: GuaranteedStake[] = [
      { stake: "White", min: 1 },
      { stake: "White", min: 3 },
    ];
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(4), [], [], [], { guaranteedStakes });
    const whiteCount = pool.filter((c) => c.stake === "White").length;
    expect(whiteCount).toBeGreaterThanOrEqual(3);
  });

  it("never produces a duplicate deck+stake combo", () => {
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(5), [], [], [], {
      maxPerDeck: 3,
      maxPerStake: 3,
      guaranteedStakes: [{ stake: "White", min: 1 }],
    });
    const seen = new Set(pool.map((c) => `${c.deck}:${c.stake}`));
    expect(seen.size).toBe(pool.length);
  });

  it("meets the requested pool size when the policy is feasible", () => {
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(6), [], [], [], {
      maxPerDeck: 3,
      maxPerStake: 4,
      guaranteedStakes: [{ stake: "White", min: 1 }],
    });
    expect(pool).toHaveLength(9);
  });

  it("excludes a zero-weight stake entirely, same as a zero-weight deck", () => {
    const stakeWeights: StakeWeight[] = [{ stake: "White", weight: 0 }];
    const pool = generatePool(DECKS, STAKES, 8, mulberry32(7), [], [], [], { stakeWeights });
    expect(pool.some((c) => c.stake === "White")).toBe(false);
  });

  it("excludes a zero-weight deck entirely, honored by both the pool and enabledDecksFor", () => {
    const deckWeights: DeckWeight[] = [{ deck: "Red", weight: 0 }];
    const pool = generatePool(DECKS, STAKES, 8, mulberry32(8), [], [], deckWeights, { maxPerDeck: 3 });
    expect(pool.some((c) => c.deck === "Red")).toBe(false);
    expect(enabledDecksFor(DECKS, deckWeights)).not.toContain("Red");
  });

  it("throws a specific error rather than looping when the policy is infeasible", () => {
    expect(() => generatePool(DECKS, STAKES, 9, mulberry32(9), [], [], [], { maxPerStake: 1 })).toThrow(
      /Cannot generate a pool for this policy/,
    );
  });

  it("still excludes excludeCombos (Bo5 no-repeats) when a policy is active", () => {
    const excludeCombos: DeckEntry[] = [
      { deck: "Red", stake: "White" },
      { deck: "Blue", stake: "Green" },
    ];
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(10), [], excludeCombos, [], {
      maxPerDeck: 3,
      maxPerStake: 4,
    });
    const excludedKeys = new Set(excludeCombos.map((c) => `${c.deck}|${c.stake}`));
    expect(pool.every((c) => !excludedKeys.has(`${c.deck}|${c.stake}`))).toBe(true);
    expect(pool).toHaveLength(9);
  });

  it("relaxes excludeCombos under an active policy when it would leave fewer than 2 combos", () => {
    const decks = ["Red"];
    const stakes = ["White", "Black"];
    const excludeCombos: DeckEntry[] = [
      { deck: "Red", stake: "White" },
      { deck: "Red", stake: "Black" },
    ];
    const pool = generatePool(decks, stakes, 2, mulberry32(11), [], excludeCombos, [], { maxPerDeck: 5 });
    expect(pool).toHaveLength(2);
    const seen = new Set(pool.map((c) => `${c.deck}|${c.stake}`));
    expect(seen).toEqual(new Set(["Red|White", "Red|Black"]));
  });

  it("still honors excludeDecks under an active policy, with the same starve fallback", () => {
    const excludeDecks = ["Blue", "Yellow", "Black"];
    // Excluding those decks leaves only Red+Green (2 decks * 5 stakes = 10
    // raw combos, which CAN still fill a pool of 9) -- exclusion honored.
    // maxPerDeck must stay loose enough (5) for 2 decks to reach 9 (2*5=10);
    // a tighter cap would make excludeDecks + the policy combinatorially
    // infeasible, which is a separate (expected) failure mode covered by
    // "throws a specific error rather than looping" above.
    const pool = generatePool(DECKS, STAKES, 9, mulberry32(12), excludeDecks, [], [], { maxPerDeck: 5, maxPerStake: 4 });
    const decksUsed = new Set(pool.map((c) => c.deck));
    for (const d of excludeDecks) expect(decksUsed.has(d)).toBe(false);
  });

  it("property: pool size, caps, guarantees, and no-duplicate-combo invariants all hold for random feasible policies", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }), // maxPerDeck
        fc.integer({ min: 1, max: 4 }), // maxPerStake
        fc.integer({ min: 0, max: 2 }), // guaranteed min for "White"
        fc.integer({ min: 1, max: 100 }),
        (maxPerDeck, maxPerStake, guaranteedMin, seed) => {
          const poolPolicy: PoolPolicy = {
            maxPerDeck,
            maxPerStake,
            guaranteedStakes: guaranteedMin > 0 ? [{ stake: "White", min: guaranteedMin }] : [],
          };
          const size = 6;
          const feasibility = checkPoolPolicyFeasibility(DECKS, STAKES, size, [], poolPolicy);
          fc.pre(feasibility.ok);

          const pool = generatePool(DECKS, STAKES, size, mulberry32(seed), [], [], [], poolPolicy);
          expect(pool).toHaveLength(size);

          const deckCounts = new Map<string, number>();
          const stakeCounts = new Map<string, number>();
          const seen = new Set<string>();
          for (const c of pool) {
            const key = `${c.deck}:${c.stake}`;
            expect(seen.has(key)).toBe(false); // no duplicate combos
            seen.add(key);
            deckCounts.set(c.deck, (deckCounts.get(c.deck) ?? 0) + 1);
            stakeCounts.set(c.stake, (stakeCounts.get(c.stake) ?? 0) + 1);
          }
          for (const count of deckCounts.values()) expect(count).toBeLessThanOrEqual(maxPerDeck);
          for (const count of stakeCounts.values()) expect(count).toBeLessThanOrEqual(maxPerStake);
          if (guaranteedMin > 0) {
            expect(stakeCounts.get("White") ?? 0).toBeGreaterThanOrEqual(guaranteedMin);
          }
        },
      ),
    );
  });
});

describe("BMP_POOL", () => {
  it("is a feasible policy for its own decks/stakes/size", () => {
    const result = checkPoolPolicyFeasibility(BMP_POOL.decks, BMP_POOL.stakes, BMP_POOL.poolSize, BMP_POOL.deckWeights, BMP_POOL.poolPolicy);
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it("includes Cocktail alongside the standard deck vocabulary", () => {
    expect(BMP_POOL.decks).toContain("Cocktail");
    expect(BMP_POOL.decks).toContain("Red");
  });

  it("generates a 9-combo pool respecting maxPerStake=4, maxPerDeck=3, and a guaranteed White, with uniform weights", () => {
    expect(BMP_POOL.deckWeights).toEqual([]);
    for (let seed = 1; seed <= 20; seed++) {
      const pool = generatePool(
        BMP_POOL.decks,
        BMP_POOL.stakes,
        BMP_POOL.poolSize,
        mulberry32(seed),
        [],
        [],
        BMP_POOL.deckWeights,
        BMP_POOL.poolPolicy,
      );
      expect(pool).toHaveLength(9);
      const deckCounts = new Map<string, number>();
      const stakeCounts = new Map<string, number>();
      const seen = new Set<string>();
      for (const c of pool) {
        expect(BMP_POOL.decks).toContain(c.deck);
        expect(BMP_POOL.stakes).toContain(c.stake);
        const key = `${c.deck}:${c.stake}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        deckCounts.set(c.deck, (deckCounts.get(c.deck) ?? 0) + 1);
        stakeCounts.set(c.stake, (stakeCounts.get(c.stake) ?? 0) + 1);
      }
      for (const count of deckCounts.values()) expect(count).toBeLessThanOrEqual(3);
      for (const count of stakeCounts.values()) expect(count).toBeLessThanOrEqual(4);
      expect(stakeCounts.get("White") ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it("still honors excludeCombos (Bo5 no-repeats) under the BMP policy", () => {
    const excludeCombos: DeckEntry[] = [{ deck: "Red", stake: "White" }];
    const pool = generatePool(
      BMP_POOL.decks,
      BMP_POOL.stakes,
      BMP_POOL.poolSize,
      mulberry32(13),
      [],
      excludeCombos,
      BMP_POOL.deckWeights,
      BMP_POOL.poolPolicy,
    );
    expect(pool.some((c) => c.deck === "Red" && c.stake === "White")).toBe(false);
  });
});
