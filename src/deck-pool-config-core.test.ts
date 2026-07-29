// Tests for the pure deck-pool-config-core parse/validate/feasibility layer.
// Ported (with adaptation -- see deck-pool-config-core.ts's module doc) from
// balatro-team-tour's apps/tour/lib/deck-pool-config-core.test.ts.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { generatePool, type GuaranteedStake, type PoolPolicy, type StakeWeight } from "./match-pool.js";
import {
  DEFAULT_POOL_CONFIG,
  DEFAULT_POOL_SIZE,
  buildPoolConfig,
  parseDeckWeights,
  parseDeckWeightsJson,
  parseGuaranteedStakes,
  parsePoolPolicy,
  parsePoolPolicyJson,
  parseStakeWeights,
  poolFeasibility,
  validatePoolConfig,
} from "./deck-pool-config-core.js";

// Same fixture DECKS/STAKES as match-config.test.ts -- real canonical names
// (required: parse*/validatePoolConfig gate on isCanonicalDeck/isCanonicalStake)
// kept small so property tests explore the combo space quickly.
const DECKS = ["Red", "Blue", "Green", "Yellow", "Black"];
const STAKES = ["White", "Green", "Black", "Blue", "Gold"];

// Small deterministic PRNG (mulberry32) -- mirrors match-config.test.ts's own
// fixture so pool assertions are reproducible without depending on
// Math.random.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("buildPoolConfig", () => {
  it("resolves a null preset to DEFAULT_POOL_CONFIG (with the given poolSize)", () => {
    const config = buildPoolConfig(null);
    expect(config).toEqual(DEFAULT_POOL_CONFIG);
    expect(config.decks).toEqual([]);
    expect(config.stakes).toEqual([]);
    expect(config.poolSize).toBe(DEFAULT_POOL_SIZE);
    expect(config.deckWeights).toEqual([]);
    expect(config.poolPolicy).toEqual({});
  });

  it("passes decks/stakes through as-is -- membership is the preset's own list, not derived here", () => {
    const config = buildPoolConfig({ decks: DECKS, stakes: STAKES, deckWeights: null }, 9);
    expect(config.decks).toEqual(DECKS);
    expect(config.stakes).toEqual(STAKES);
  });

  it("parses the JSON-serialized deckWeights column", () => {
    const config = buildPoolConfig(
      { decks: DECKS, stakes: STAKES, deckWeights: JSON.stringify([{ deck: "Red", weight: 0 }, { deck: "Blue", weight: 3 }]) },
      9,
    );
    expect(config.deckWeights).toEqual([{ deck: "Red", weight: 0 }, { deck: "Blue", weight: 3 }]);
  });

  it("falls back to DEFAULT_POOL_SIZE for a non-positive, non-integer, or missing poolSize", () => {
    const preset = { decks: DECKS, stakes: STAKES, deckWeights: null };
    expect(buildPoolConfig(preset, 0).poolSize).toBe(DEFAULT_POOL_SIZE);
    expect(buildPoolConfig(preset, -3).poolSize).toBe(DEFAULT_POOL_SIZE);
    expect(buildPoolConfig(preset, 4.5).poolSize).toBe(DEFAULT_POOL_SIZE);
    expect(buildPoolConfig(preset, null).poolSize).toBe(DEFAULT_POOL_SIZE);
    expect(buildPoolConfig(preset).poolSize).toBe(DEFAULT_POOL_SIZE);
  });

  it("a preset row with no poolPolicy field at all (predates the column) resolves to {}", () => {
    const config = buildPoolConfig({ decks: DECKS, stakes: STAKES, deckWeights: null });
    expect(config.poolPolicy).toEqual({});
  });

  it("parses the JSON-serialized poolPolicy column", () => {
    const poolPolicy: PoolPolicy = { maxPerDeck: 3, maxPerStake: 4, guaranteedStakes: [{ stake: "White", min: 1 }] };
    const config = buildPoolConfig({
      decks: DECKS,
      stakes: STAKES,
      deckWeights: null,
      poolPolicy: JSON.stringify(poolPolicy),
    });
    expect(config.poolPolicy).toEqual(poolPolicy);
  });
});

describe("parseDeckWeightsJson", () => {
  it.each<[string, string | null, { deck: string; weight: number }[]]>([
    ["a real JSON-serialized DeckWeight[] passes through", JSON.stringify([{ deck: "Red", weight: 0 }]), [{ deck: "Red", weight: 0 }]],
    ["null falls back to no overrides", null, []],
    ["an empty string falls back to no overrides", "", []],
    ["malformed JSON falls back to no overrides (never throws)", "{not json", []],
    ["valid JSON that isn't an array falls back to no overrides", JSON.stringify({ deck: "Red", weight: 0 }), []],
  ])("%s", (_name, input, expected) => {
    expect(parseDeckWeightsJson(input)).toEqual(expected);
  });
});

describe("parseDeckWeights", () => {
  it.each<[string, unknown, { deck: string; weight: number }[]]>([
    ["a real deck/weight pair passes through", [{ deck: "Red", weight: 0 }], [{ deck: "Red", weight: 0 }]],
    ["an unrecognized deck is dropped", [{ deck: "Nonsense", weight: 2 }], []],
    ["a non-finite weight is dropped", [{ deck: "Red", weight: NaN }], []],
    ["a non-numeric weight is dropped", [{ deck: "Red", weight: "5" }], []],
    ["a non-array falls back to no overrides", "garbage", []],
    ["null falls back to no overrides", null, []],
    ["a negative weight (a valid exclusion) passes through", [{ deck: "Red", weight: -1 }], [{ deck: "Red", weight: -1 }]],
  ])("%s", (_name, input, expected) => {
    expect(parseDeckWeights(input)).toEqual(expected);
  });
});

describe("parseStakeWeights", () => {
  it.each<[string, unknown, StakeWeight[]]>([
    ["a real stake/weight pair passes through", [{ stake: "White", weight: 0 }], [{ stake: "White", weight: 0 }]],
    ["an unrecognized stake is dropped", [{ stake: "Nonsense", weight: 2 }], []],
    ["a non-finite weight is dropped", [{ stake: "White", weight: NaN }], []],
    ["a non-array falls back to no overrides", "garbage", []],
    ["null falls back to no overrides", null, []],
    ["a negative weight (a valid exclusion) passes through", [{ stake: "White", weight: -1 }], [{ stake: "White", weight: -1 }]],
  ])("%s", (_name, input, expected) => {
    expect(parseStakeWeights(input)).toEqual(expected);
  });
});

describe("parseGuaranteedStakes", () => {
  it.each<[string, unknown, GuaranteedStake[]]>([
    ["a real stake/min pair passes through", [{ stake: "White", min: 2 }], [{ stake: "White", min: 2 }]],
    ["an unrecognized stake is dropped", [{ stake: "Nonsense", min: 1 }], []],
    ["a zero min is dropped (a no-op floor)", [{ stake: "White", min: 0 }], []],
    ["a negative min is dropped", [{ stake: "White", min: -1 }], []],
    ["a non-finite min is dropped", [{ stake: "White", min: NaN }], []],
    ["a non-array falls back to no guarantees", "garbage", []],
    ["null falls back to no guarantees", null, []],
  ])("%s", (_name, input, expected) => {
    expect(parseGuaranteedStakes(input)).toEqual(expected);
  });
});

describe("parsePoolPolicy / parsePoolPolicyJson", () => {
  it("passes through a well-formed policy in full", () => {
    const policy = {
      maxPerDeck: 3,
      maxPerStake: 4,
      guaranteedStakes: [{ stake: "White", min: 1 }],
      stakeWeights: [{ stake: "Gold", weight: 0.5 }],
    };
    expect(parsePoolPolicy(policy)).toEqual(policy);
  });

  it("drops each malformed field independently rather than discarding the whole policy", () => {
    const result = parsePoolPolicy({
      maxPerDeck: -1, // invalid -- dropped
      maxPerStake: 4, // valid -- kept
      guaranteedStakes: [{ stake: "Nonsense", min: 1 }], // invalid entry -- dropped
      stakeWeights: [{ stake: "Gold", weight: 2 }], // valid -- kept
    });
    expect(result).toEqual({ maxPerStake: 4, stakeWeights: [{ stake: "Gold", weight: 2 }] });
  });

  it("a non-object, null, or empty object all resolve to {}", () => {
    expect(parsePoolPolicy(null)).toEqual({});
    expect(parsePoolPolicy("garbage")).toEqual({});
    expect(parsePoolPolicy({})).toEqual({});
  });

  it("parsePoolPolicyJson round-trips a serialized policy and degrades malformed JSON to {}", () => {
    const policy: PoolPolicy = { maxPerDeck: 2, guaranteedStakes: [{ stake: "White", min: 1 }] };
    expect(parsePoolPolicyJson(JSON.stringify(policy))).toEqual(policy);
    expect(parsePoolPolicyJson(null)).toEqual({});
    expect(parsePoolPolicyJson("{not json")).toEqual({});
  });
});

describe("poolFeasibility", () => {
  it("a deck absent from a non-empty weights list defaults to weight 1 (stays enabled)", () => {
    const result = poolFeasibility(DECKS, STAKES, [{ deck: "Red", weight: 5 }], DECKS.length);
    expect(result.enabledDeckCount).toBe(DECKS.length); // every other deck implicitly weight 1, still enabled
  });

  it("weight <= 0 excludes a deck entirely; any weight > 0 (even tiny) keeps it enabled", () => {
    expect(poolFeasibility(DECKS, STAKES, [{ deck: "Red", weight: 0 }], 1).enabledDeckCount).toBe(DECKS.length - 1);
    expect(poolFeasibility(DECKS, STAKES, [{ deck: "Red", weight: -3 }], 1).enabledDeckCount).toBe(DECKS.length - 1);
    expect(poolFeasibility(DECKS, STAKES, [{ deck: "Red", weight: 0.01 }], 1).enabledDeckCount).toBe(DECKS.length);
  });

  it("an empty deckWeights list is fully uniform -- every deck enabled", () => {
    expect(poolFeasibility(DECKS, STAKES, [], 1).enabledDeckCount).toBe(DECKS.length);
  });

  it("is feasible for a comfortable policy and reasons is empty", () => {
    const result = poolFeasibility(DECKS, STAKES, [], DEFAULT_POOL_SIZE, { maxPerDeck: 3, maxPerStake: 4 });
    expect(result.feasible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("flags a maxPerStake cap too tight, with the specific reason surfaced", () => {
    // Only 2 stakes enabled x maxPerStake 1 = 2 combos, short of DEFAULT_POOL_SIZE (9).
    const result = poolFeasibility(DECKS, ["White", "Red"], [], DEFAULT_POOL_SIZE, { maxPerStake: 1 });
    expect(result.feasible).toBe(false);
    expect(result.reasons.some((r) => r.includes("allows at most 2"))).toBe(true);
  });

  it("a zero-weight stake is excluded from enabledStakeCount, same as a zero-weight deck", () => {
    const result = poolFeasibility(DECKS, STAKES, [], DEFAULT_POOL_SIZE, {
      stakeWeights: [{ stake: "White", weight: 0 }],
    });
    expect(result.enabledStakeCount).toBe(STAKES.length - 1);
  });

  it("defaults to {} when poolPolicy is omitted -- identical to the pre-policy signature", () => {
    const withDefault = poolFeasibility(DECKS, STAKES, [], DEFAULT_POOL_SIZE);
    const withEmpty = poolFeasibility(DECKS, STAKES, [], DEFAULT_POOL_SIZE, {});
    expect(withDefault).toEqual(withEmpty);
  });
});

describe("validatePoolConfig", () => {
  it("rejects a config that can't fill its own pool size (too few enabled decks/stakes)", () => {
    const deckWeights = DECKS.map((deck) => ({ deck, weight: deck === "Red" ? 1 : 0 })); // only Red enabled
    const result = validatePoolConfig({ decks: DECKS, stakes: ["White"], poolSize: 5, deckWeights });
    expect(result.ok).toBe(false);
    expect(result.maxCombos).toBe(1); // 1 enabled deck x 1 enabled stake
    expect(result.errors.some((e) => e.includes("short of the pool size"))).toBe(true);
  });

  it("accepts a feasible config", () => {
    const result = validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: DECKS.length * STAKES.length, deckWeights: [] });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("requires at least one enabled deck", () => {
    const result = validatePoolConfig({ decks: [], stakes: STAKES, poolSize: 1, deckWeights: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("At least one deck"))).toBe(true);
  });

  it("requires at least one enabled stake", () => {
    const result = validatePoolConfig({ decks: DECKS, stakes: [], poolSize: 1, deckWeights: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("At least one stake"))).toBe(true);
  });

  it("rejects a non-integer or non-positive pool size", () => {
    expect(validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: 0, deckWeights: [] }).ok).toBe(false);
    expect(validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: -1, deckWeights: [] }).ok).toBe(false);
    expect(validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: 2.5, deckWeights: [] }).ok).toBe(false);
  });

  it("rejects an unrecognized deck/stake in the membership lists", () => {
    const badDeck = validatePoolConfig({ decks: [...DECKS, "Nonsense"], stakes: STAKES, poolSize: 9, deckWeights: [] });
    expect(badDeck.ok).toBe(false);
    expect(badDeck.errors.some((e) => e.includes("decks weren't recognized"))).toBe(true);

    const badStake = validatePoolConfig({ decks: DECKS, stakes: [...STAKES, "Nonsense"], poolSize: 9, deckWeights: [] });
    expect(badStake.ok).toBe(false);
    expect(badStake.errors.some((e) => e.includes("stakes weren't recognized"))).toBe(true);
  });

  it("accepts a feasible policy (caps + a guarantee)", () => {
    const result = validatePoolConfig({
      decks: DECKS,
      stakes: STAKES,
      poolSize: DEFAULT_POOL_SIZE,
      deckWeights: [],
      maxPerDeck: 3,
      maxPerStake: 4,
      guaranteedStakes: [{ stake: "White", min: 1 }],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a non-positive or non-integer maxPerDeck/maxPerStake", () => {
    expect(validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: 9, deckWeights: [], maxPerDeck: 0 }).ok).toBe(false);
    expect(validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: 9, deckWeights: [], maxPerDeck: -1 }).ok).toBe(false);
    expect(validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: 9, deckWeights: [], maxPerDeck: 1.5 }).ok).toBe(false);
    expect(validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: 9, deckWeights: [], maxPerStake: 0 }).ok).toBe(false);
  });

  it("rejects an unrecognized stake in stakeWeights/guaranteedStakes", () => {
    const badStakeWeight = validatePoolConfig({
      decks: DECKS,
      stakes: STAKES,
      poolSize: 9,
      deckWeights: [],
      stakeWeights: [{ stake: "Nonsense", weight: 1 }],
    });
    expect(badStakeWeight.ok).toBe(false);
    expect(badStakeWeight.errors.some((e) => e.includes("stake weights weren't recognized"))).toBe(true);

    const badGuarantee = validatePoolConfig({
      decks: DECKS,
      stakes: STAKES,
      poolSize: 9,
      deckWeights: [],
      guaranteedStakes: [{ stake: "Nonsense", min: 1 }],
    });
    expect(badGuarantee.ok).toBe(false);
    expect(badGuarantee.errors.some((e) => e.includes("guaranteed stakes weren't recognized"))).toBe(true);
  });

  it("rejects a policy that can't fill its own pool -- caps too tight", () => {
    // Only 2 stakes enabled x maxPerStake 1 = 2 combos, short of a pool size of 9.
    const result = validatePoolConfig({ decks: DECKS, stakes: ["White", "Red"], poolSize: 9, deckWeights: [], maxPerStake: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("allows at most 2"))).toBe(true);
  });

  it("rejects guarantees summing past the pool size", () => {
    const result = validatePoolConfig({
      decks: DECKS,
      stakes: STAKES,
      poolSize: 3,
      deckWeights: [],
      guaranteedStakes: [
        { stake: "White", min: 2 },
        { stake: "Red", min: 2 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("more than the pool size"))).toBe(true);
  });

  it("omitting every policy field behaves exactly as before this feature existed", () => {
    const result = validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: DECKS.length * STAKES.length, deckWeights: [] });
    expect(result.ok).toBe(true);
  });

  it("all-decks-zero-weight is rejected as infeasible (no enabled decks)", () => {
    const deckWeights = DECKS.map((deck) => ({ deck, weight: 0 }));
    const result = validatePoolConfig({ decks: DECKS, stakes: STAKES, poolSize: 1, deckWeights });
    expect(result.ok).toBe(false);
    expect(result.enabledDeckCount).toBe(0);
    expect(result.reasons).toContain("No decks are enabled.");
  });

  it("rejects a guarantee minimum greater than maxPerStake on the same stake", () => {
    const result = validatePoolConfig({
      decks: DECKS,
      stakes: STAKES,
      poolSize: 9,
      deckWeights: [],
      maxPerStake: 1,
      guaranteedStakes: [{ stake: "White", min: 3 }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds its own maxPerStake cap of 1"))).toBe(true);
  });
});

// Byte-compat: a preset with NO weights/policy must generate the exact same
// pool generatePool always has -- deck-pool-config-core sits entirely in
// front of generatePool as an admin-facing config layer; it must never
// change what an unconfigured (or freshly-migrated) preset produces.
describe("a preset with no weights/policy is byte-compatible with the pre-feature pool", () => {
  it("buildPoolConfig(preset-with-null-columns) drives generatePool identically to the plain 4-arg call", () => {
    const config = buildPoolConfig({ decks: DECKS, stakes: STAKES, deckWeights: null, poolPolicy: null }, 9);
    const before = generatePool(DECKS, STAKES, 9, mulberry32(4242));
    const after = generatePool(config.decks, config.stakes, config.poolSize, mulberry32(4242), [], [], config.deckWeights, config.poolPolicy);
    expect(after).toEqual(before);
  });
});

// Property: whatever an admin can actually SAVE (validatePoolConfig ok:true)
// is a valid input to the real generatePool -- i.e. it never starves the
// pool. Exercises the actual match-pool.ts function rather than
// reimplementing its combo math, so a change to generatePool's contract
// would fail this test too.
describe("a feasible config never starves generatePool", () => {
  it("produces exactly poolSize unique, in-bounds combos for any feasible deck/stake membership", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...DECKS), { minLength: 1 }),
        fc.uniqueArray(fc.constantFrom(...STAKES), { minLength: 1 }),
        fc.integer({ min: 1, max: 25 }),
        (enabledDecks, enabledStakes, rawPoolSize) => {
          const maxCombos = enabledDecks.length * enabledStakes.length;
          const poolSize = Math.min(rawPoolSize, maxCombos);

          const validation = validatePoolConfig({ decks: enabledDecks, stakes: enabledStakes, poolSize, deckWeights: [] });
          expect(validation.ok).toBe(true);

          const config = buildPoolConfig({ decks: enabledDecks, stakes: enabledStakes, deckWeights: null }, poolSize);
          const pool = generatePool(config.decks, config.stakes, config.poolSize, mulberry32(poolSize + enabledDecks.length), [], [], config.deckWeights);

          expect(pool).toHaveLength(poolSize);
          const seen = new Set(pool.map((c) => `${c.deck}:${c.stake}`));
          expect(seen.size).toBe(poolSize); // no duplicate combos
          for (const combo of pool) {
            expect(enabledDecks).toContain(combo.deck);
            expect(enabledStakes).toContain(combo.stake);
          }
        },
      ),
    );
  });
});

// Property: whatever an admin can actually SAVE with a policy
// (validatePoolConfig ok:true) is a valid input to the real generatePool --
// it produces exactly poolSize combos and never violates a cap or
// guarantee.
describe("a feasible policy config never dead-ends generatePool", () => {
  it("produces exactly poolSize combos respecting every cap/guarantee for any feasible policy", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }), // maxPerDeck
        fc.integer({ min: 2, max: 5 }), // maxPerStake
        fc.integer({ min: 0, max: 2 }), // guaranteed min for "White"
        fc.integer({ min: 1, max: 100 }),
        (maxPerDeck, maxPerStake, guaranteedMin, seed) => {
          const poolSize = 5;
          const guaranteedStakes: GuaranteedStake[] = guaranteedMin > 0 ? [{ stake: "White", min: guaranteedMin }] : [];
          const validation = validatePoolConfig({
            decks: DECKS,
            stakes: STAKES,
            poolSize,
            deckWeights: [],
            maxPerDeck,
            maxPerStake,
            guaranteedStakes,
          });
          fc.pre(validation.ok);

          const config = buildPoolConfig(
            { decks: DECKS, stakes: STAKES, deckWeights: null, poolPolicy: JSON.stringify({ maxPerDeck, maxPerStake, guaranteedStakes }) },
            poolSize,
          );
          const pool = generatePool(config.decks, config.stakes, config.poolSize, mulberry32(seed), [], [], config.deckWeights, config.poolPolicy);

          expect(pool).toHaveLength(poolSize);
          const deckCounts = new Map<string, number>();
          const stakeCounts = new Map<string, number>();
          const seen = new Set<string>();
          for (const c of pool) {
            const key = `${c.deck}:${c.stake}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
            deckCounts.set(c.deck, (deckCounts.get(c.deck) ?? 0) + 1);
            stakeCounts.set(c.stake, (stakeCounts.get(c.stake) ?? 0) + 1);
          }
          for (const count of deckCounts.values()) expect(count).toBeLessThanOrEqual(maxPerDeck);
          for (const count of stakeCounts.values()) expect(count).toBeLessThanOrEqual(maxPerStake);
          if (guaranteedMin > 0) expect(stakeCounts.get("White") ?? 0).toBeGreaterThanOrEqual(guaranteedMin);
        },
      ),
    );
  });
});
