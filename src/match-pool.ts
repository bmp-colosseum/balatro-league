// Pure deck/stake pool-generation engine -- no prisma/DB/I-O. Split out of
// match-config.ts (which still owns the impure preset resolvers +
// bootstrap) so this half can be shared verbatim with the web app (synced
// to web/lib/match-pool.ts -- see web/scripts/sync-schema.mjs) and unit-
// tested without a database. match-config.ts re-exports everything here
// (`export * from "./match-pool.js"`), so every existing `from
// "./match-config.js"` / `"../match-config.js"` import keeps working
// unchanged -- this split is a pure code move, no behavior change.

import defaults from "./data/match-defaults.json" with { type: "json" };

export const DEFAULT_POOL_SIZE = 9;

export interface DeckEntry {
  deck: string;
  stake: string;
}

// ---- Pool policy (BMP-style bans) ------------------------------------------
// Extends plain deck/stake pool generation with optional per-deck/per-stake
// WEIGHTS and a POOL POLICY (caps + guaranteed minimums). Ported from
// balatro-team-tour's packages/match-core/src/match-pool.ts, which was
// itself ported FROM this file originally -- see
// .claude/knowledge/bmp-style-bans/ for the source data + algorithm.
//
// Uniform behavior is the DEFAULT: call generatePool with no deckWeights (or
// an empty array) AND no active poolPolicy knob and it runs the EXACT
// original Fisher-Yates-shuffle path below, with the exact original rand()
// call pattern -- byte-for-byte, not just statistically. Every existing
// caller (random.ts, pool.ts, and match-buttons.ts's non-BMP matches) is
// unaffected. A non-empty deckWeights list alone engages an A-Res weighted
// sample; any PoolPolicy knob set (maxPerDeck, maxPerStake, guaranteedStakes,
// stakeWeights) engages a separate constrained generator with its own
// dead-end strategy (see generatePoolWithPolicy below) -- no byte-compat
// promise of its own, only weight-proportional output plus every
// cap/guarantee/no-duplicate invariant (see match-config.test.ts).

// A deck's relative likelihood of appearing in a generated pool. A deck NOT
// listed here defaults to weight 1 (uniform). weight <= 0 means the deck is
// EXCLUDED from the pool entirely -- a deliberate config choice, distinct
// from excludeDecks below (the per-match "don't repeat game 1's decks"
// variety exclusion, which has a starve-fallback).
export interface DeckWeight {
  deck: string;
  weight: number;
}

// A stake's relative likelihood of appearing, mirroring DeckWeight exactly:
// unlisted = weight 1 (uniform), weight <= 0 = excluded entirely. Only takes
// effect via the PoolPolicy constrained-generation path.
export interface StakeWeight {
  stake: string;
  weight: number;
}

// A floor on how many times `stake` must appear in a generated pool. Multiple
// entries for the same stake are merged to their MAX (the strongest floor
// requested), not summed.
export interface GuaranteedStake {
  stake: string;
  min: number;
}

// The full pool-generation policy beyond plain deck weighting: per-deck and
// per-stake occurrence caps, guaranteed-stake minimums, and per-stake
// weights. Every field is optional and independently activating -- setting
// NONE of them (the default {}) keeps generatePool on its original,
// unpolicied path.
export interface PoolPolicy {
  maxPerDeck?: number;
  maxPerStake?: number;
  guaranteedStakes?: ReadonlyArray<GuaranteedStake>;
  stakeWeights?: ReadonlyArray<StakeWeight>;
}

function weightFor(deck: string, weights: ReadonlyArray<DeckWeight>): number {
  const found = weights.find((w) => w.deck === deck);
  return found ? found.weight : 1;
}

// The decks a configuration actually allows: a deck weighted <= 0 is switched
// OFF, not merely made rare. Exported so pool generation and any future
// custom-combo allow-list derive "which decks may appear" from ONE predicate.
export function enabledDecksFor(
  decks: ReadonlyArray<string>,
  deckWeights: ReadonlyArray<DeckWeight> = [],
): string[] {
  return deckWeights.length > 0 ? decks.filter((d) => weightFor(d, deckWeights) > 0) : [...decks];
}

function stakeWeightFor(stake: string, weights: ReadonlyArray<StakeWeight>): number {
  const found = weights.find((w) => w.stake === stake);
  return found ? found.weight : 1;
}

// The stakes a configuration actually allows -- the stake-axis twin of
// enabledDecksFor, identical semantics (unlisted = weight 1 = on, weight <= 0
// = switched OFF).
export function enabledStakesFor(
  stakes: ReadonlyArray<string>,
  stakeWeights: ReadonlyArray<StakeWeight> = [],
): string[] {
  return stakeWeights.length > 0 ? stakes.filter((s) => stakeWeightFor(s, stakeWeights) > 0) : [...stakes];
}

function mergeGuaranteedStakes(guaranteedStakes: ReadonlyArray<GuaranteedStake>): GuaranteedStake[] {
  const byStake = new Map<string, number>();
  for (const g of guaranteedStakes) {
    const current = byStake.get(g.stake) ?? 0;
    if (g.min > current) byStake.set(g.stake, g.min);
  }
  return [...byStake.entries()].map(([stake, min]) => ({ stake, min })).filter((g) => g.min > 0);
}

export interface PoolPolicyFeasibility {
  ok: boolean;
  reasons: string[];
}

// Arithmetic (necessary-condition) feasibility check for a pool policy, meant
// to run BEFORE generatePool: are the enabled decks/stakes, caps, and
// guarantees even capable of filling a pool of `size`. Not a general
// constraint solver -- catches every clearly-broken config with a specific
// reason. generatePool re-runs this itself and throws on failure, so a
// caller that skips this check still can't get a bad pool -- it only loses
// the up-front reason.
export function checkPoolPolicyFeasibility(
  decks: string[],
  stakes: string[],
  size: number,
  deckWeights: ReadonlyArray<DeckWeight> = [],
  poolPolicy: PoolPolicy = {},
): PoolPolicyFeasibility {
  const reasons: string[] = [];
  const stakeWeights = poolPolicy.stakeWeights ?? [];
  const enabledDecks = enabledDecksFor(decks, deckWeights);
  const enabledStakes = enabledStakesFor(stakes, stakeWeights);

  if (enabledDecks.length === 0) reasons.push("No decks are enabled.");
  if (enabledStakes.length === 0) reasons.push("No stakes are enabled.");
  if (enabledDecks.length === 0 || enabledStakes.length === 0) return { ok: false, reasons };

  const maxCombos = enabledDecks.length * enabledStakes.length;
  if (maxCombos < size) {
    reasons.push(
      `${enabledDecks.length} enabled deck${enabledDecks.length === 1 ? "" : "s"} x ${enabledStakes.length} ` +
        `enabled stake${enabledStakes.length === 1 ? "" : "s"} = ${maxCombos} possible combo${maxCombos === 1 ? "" : "s"}, ` +
        `short of the pool size of ${size}.`,
    );
  }

  if (poolPolicy.maxPerDeck !== undefined) {
    const cap = poolPolicy.maxPerDeck * enabledDecks.length;
    if (cap < size) {
      reasons.push(
        `${enabledDecks.length} deck${enabledDecks.length === 1 ? "" : "s"} at max ${poolPolicy.maxPerDeck} each ` +
          `cannot fill a pool of ${size} (allows at most ${cap}).`,
      );
    }
  }

  if (poolPolicy.maxPerStake !== undefined) {
    const cap = poolPolicy.maxPerStake * enabledStakes.length;
    if (cap < size) {
      reasons.push(
        `${enabledStakes.length} stake${enabledStakes.length === 1 ? "" : "s"} at max ${poolPolicy.maxPerStake} each ` +
          `cannot fill a pool of ${size} (allows at most ${cap}).`,
      );
    }
  }

  const guarantees = mergeGuaranteedStakes(poolPolicy.guaranteedStakes ?? []);
  const guaranteedTotal = guarantees.reduce((sum, g) => sum + g.min, 0);
  if (guaranteedTotal > size) {
    reasons.push(`Guaranteed stake minimums total ${guaranteedTotal}, more than the pool size of ${size}.`);
  }
  for (const g of guarantees) {
    if (!enabledStakes.includes(g.stake)) {
      reasons.push(`Guaranteed stake "${g.stake}" is not enabled.`);
      continue;
    }
    if (g.min > enabledDecks.length) {
      reasons.push(
        `Guaranteed minimum of ${g.min} for stake "${g.stake}" needs ${g.min} distinct decks, but only ` +
          `${enabledDecks.length} are enabled.`,
      );
    }
    if (poolPolicy.maxPerStake !== undefined && g.min > poolPolicy.maxPerStake) {
      reasons.push(
        `Guaranteed minimum of ${g.min} for stake "${g.stake}" exceeds its own maxPerStake cap of ` +
          `${poolPolicy.maxPerStake}.`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}

// The fixed BMP-style pool: a restricted deck/stake vocabulary with per-
// stake/per-deck caps and a guaranteed White stake, matching the ranked
// policy Botlatro/BMP already runs (see
// .claude/knowledge/bmp-style-bans/02-bmp-pr-data-and-algorithm.md). Fixed
// and hardcoded for this pass -- no DB preset, no admin editor, no weekly
// cocktail rotation. deckWeights stays empty (uniform, matching the BMP
// ranked seed) but is wired through generatePool for later tuning.
export interface BmpPoolConfig {
  decks: string[];
  stakes: string[];
  poolSize: number;
  poolPolicy: PoolPolicy;
  deckWeights: DeckWeight[];
}

export const BMP_POOL: BmpPoolConfig = {
  decks: [...defaults.decks, "Cocktail"],
  // Spectral+ is a draftable stake but weighted to 0.5, so combos on it appear
  // about half as often as the base stakes (all unlisted = weight 1).
  stakes: ["White", "Green", "Black", "Purple", "Gold", "Spectral+"],
  poolSize: 9,
  poolPolicy: {
    maxPerStake: 4,
    maxPerDeck: 3,
    guaranteedStakes: [{ stake: "White", min: 1 }],
    stakeWeights: [{ stake: "Spectral+", weight: 0.5 }],
  },
  deckWeights: [],
};

// The BMP pool with or without the Spectral+ stake (per-match toggle, default
// on). When excluded, Spectral+ drops out of both the stake list and its weight
// entry so it can never be drawn.
export function bmpPoolConfig(includeSpectral: boolean): BmpPoolConfig {
  if (includeSpectral) return BMP_POOL;
  return {
    ...BMP_POOL,
    stakes: BMP_POOL.stakes.filter((s) => s !== "Spectral+"),
    poolPolicy: {
      ...BMP_POOL.poolPolicy,
      stakeWeights: (BMP_POOL.poolPolicy.stakeWeights ?? []).filter((w) => w.stake !== "Spectral+"),
    },
  };
}

// Cartesian product of (deck x stake), shuffled and sliced. No duplicate combos.
// excludeDecks: deck NAMES to skip -- used by game 2/3 to avoid repeating any
// deck that already showed up in a prior game's pool. If filtering would
// leave too few combos to fill `size`, we fall back to including the
// excluded decks so the match can still proceed.
// excludeCombos: exact (deck+stake) combos to hard-drop -- the Bo5 "no repeats"
// rule, fed the deck+stake actually PLAYED in each earlier game so it can't be
// picked twice. Only relaxed if dropping them would leave fewer than 2 combos
// (which would break the final pick); a normal-size pool never hits that.
// deckWeights / poolPolicy: optional BMP-style extensions (see the pool
// policy section above). Omitted (or both empty/`{}`) takes the ORIGINAL,
// byte-compatible path below -- every existing caller is unaffected.
export function generatePool(
  decks: string[],
  stakes: string[],
  size: number = DEFAULT_POOL_SIZE,
  rand: () => number = Math.random,
  excludeDecks: string[] = [],
  excludeCombos: DeckEntry[] = [],
  deckWeights: ReadonlyArray<DeckWeight> = [],
  poolPolicy: PoolPolicy = {},
): DeckEntry[] {
  const hasPolicy =
    poolPolicy.maxPerDeck !== undefined ||
    poolPolicy.maxPerStake !== undefined ||
    (poolPolicy.guaranteedStakes?.length ?? 0) > 0 ||
    (poolPolicy.stakeWeights?.length ?? 0) > 0;

  if (hasPolicy) {
    return generatePoolWithPolicy(decks, stakes, size, rand, excludeDecks, excludeCombos, deckWeights, poolPolicy);
  }

  if (deckWeights.length === 0) {
    // The EXACT original path -- same rand() call pattern as before this
    // feature existed. Never touch this branch's shape; it's the byte-compat
    // promise every existing caller relies on.
    const excluded = new Set(excludeDecks);
    const filteredDecks = decks.filter((d) => !excluded.has(d));
    // Only honor the deck exclusion if the filtered set can still fill the pool.
    // Otherwise fall back to the full deck list so the match doesn't stall.
    const usable = filteredDecks.length * stakes.length >= size ? filteredDecks : decks;
    const comboKey = (d: string, s: string) => `${d}|${s}`;
    const bannedCombos = new Set(excludeCombos.map((c) => comboKey(c.deck, c.stake)));
    const build = (dropCombos: boolean): DeckEntry[] => {
      const out: DeckEntry[] = [];
      for (const deck of usable) {
        for (const stake of stakes) {
          if (dropCombos && bannedCombos.has(comboKey(deck, stake))) continue;
          out.push({ deck, stake });
        }
      }
      return out;
    };
    // Hard-drop played combos (no-repeat); relax only if it would starve the
    // final 2-combo pick.
    let combos = build(bannedCombos.size > 0);
    if (combos.length < 2) combos = build(false);
    if (combos.length < size) return shuffle(combos, rand);
    return shuffle(combos, rand).slice(0, size);
  }

  // deckWeights set, no PoolPolicy knob: A-Res weighted sample (deck-level
  // only), still honoring excludeDecks/excludeCombos with the same
  // starve-fallback semantics as the unweighted path above.
  const enabledDecks = enabledDecksFor(decks, deckWeights);
  const excluded = new Set(excludeDecks);
  const filteredDecks = enabledDecks.filter((d) => !excluded.has(d));
  const usable = filteredDecks.length * stakes.length >= size ? filteredDecks : enabledDecks;
  const comboKey = (d: string, s: string) => `${d}|${s}`;
  const bannedCombos = new Set(excludeCombos.map((c) => comboKey(c.deck, c.stake)));
  const build = (dropCombos: boolean): DeckEntry[] => {
    const out: DeckEntry[] = [];
    for (const deck of usable) {
      for (const stake of stakes) {
        if (dropCombos && bannedCombos.has(comboKey(deck, stake))) continue;
        out.push({ deck, stake });
      }
    }
    return out;
  };
  let weightedCombos = build(bannedCombos.size > 0);
  if (weightedCombos.length < 2) weightedCombos = build(false);
  if (weightedCombos.length < size) return shuffle(weightedCombos, rand);
  return weightedSample(weightedCombos, size, rand, deckWeights);
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Weighted random sample WITHOUT replacement (Efraimidis-Spirakis A-Res):
// each combo gets a key = rand()^(1/weight), and taking the top `size` keys
// by that key is equivalent to sampling proportional to weight, in one
// deterministic pass given an injected `rand`. Deck weight only -- stakes
// stay uniform within a deck. Only used by the deckWeights-without-policy
// path above; the constrained generator below has its own sampling
// primitive (weightedPickFrom).
function weightedSample(
  combos: DeckEntry[],
  size: number,
  rand: () => number,
  deckWeights: ReadonlyArray<DeckWeight>,
): DeckEntry[] {
  const keyed = combos.map((combo) => ({
    combo,
    key: Math.pow(rand(), 1 / weightFor(combo.deck, deckWeights)),
  }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, size).map((k) => k.combo);
}

// Roulette-wheel weighted pick (one rand() call per pick) -- the constrained
// generator's own sampling primitive. Unlike weightedSample above, this picks
// ONE item at a time against a live, shrinking candidate set (caps/guarantees
// change what's eligible after every pick), so an A-Res multi-pick sample
// doesn't apply here; there is no compatibility promise tying this to any
// particular rand() call pattern.
function weightedPickFrom<T>(items: readonly T[], rand: () => number, weightOf: (item: T) => number): T {
  const weights = items.map(weightOf);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rand() * items.length)]!;
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!; // floating-point residue fallback
}

// The constrained generator: guarantees reserved first (most-constrained --
// largest `min` -- first), then the remainder filled from whatever's still
// eligible under maxPerDeck/maxPerStake, weighted by deck x stake weight.
// Deterministic given `rand` -- no retry loop, no bounded-attempts counter
// (see the module doc above for why this strategy was chosen over BMP
// server's Efraimidis-Spirakis A-Res-with-retry variant). Also honors
// excludeDecks (same >= size starve-fallback as the unpolicied path) and
// excludeCombos (same < 2 starve-fallback) so the league's Bo5 no-repeat
// rule keeps working when a policy is active.
function generatePoolWithPolicy(
  decks: string[],
  stakes: string[],
  size: number,
  rand: () => number,
  excludeDecks: string[],
  excludeCombos: DeckEntry[],
  deckWeights: ReadonlyArray<DeckWeight>,
  poolPolicy: PoolPolicy,
): DeckEntry[] {
  const feasibility = checkPoolPolicyFeasibility(decks, stakes, size, deckWeights, poolPolicy);
  if (!feasibility.ok) {
    throw new Error(`Cannot generate a pool for this policy: ${feasibility.reasons.join(" ")}`);
  }

  const stakeWeights = poolPolicy.stakeWeights ?? [];
  // ONE predicate per axis, shared with the unpolicied generator and
  // checkPoolPolicyFeasibility above -- the pool and the feasibility check
  // can never disagree about "which decks/stakes may appear".
  const enabledDecks = enabledDecksFor(decks, deckWeights);
  const enabledStakes = enabledStakesFor(stakes, stakeWeights);

  const excludedDecksSet = new Set(excludeDecks);
  const filteredDecks = enabledDecks.filter((d) => !excludedDecksSet.has(d));
  const usableDecks = filteredDecks.length * enabledStakes.length >= size ? filteredDecks : enabledDecks;

  const comboKey = (d: string, s: string): string => `${d}|${s}`;
  const excludedCombosSet = new Set(excludeCombos.map((c) => comboKey(c.deck, c.stake)));
  // Same "relax only if it would starve the pick" rule as the unpolicied
  // path: only honor the combo exclusion if doing so leaves at least 2
  // eligible combos across the usable decks/enabled stakes.
  let dropCombos = excludedCombosSet.size > 0;
  if (dropCombos) {
    let remaining = 0;
    for (const d of usableDecks) {
      for (const s of enabledStakes) {
        if (!excludedCombosSet.has(comboKey(d, s))) remaining++;
      }
    }
    if (remaining < 2) dropCombos = false;
  }

  const { maxPerDeck, maxPerStake } = poolPolicy;
  const deckCount = new Map<string, number>();
  const stakeCount = new Map<string, number>();
  const used = new Set<string>();
  const pool: DeckEntry[] = [];

  const canUse = (deck: string, stake: string): boolean => {
    if (used.has(comboKey(deck, stake))) return false;
    if (dropCombos && excludedCombosSet.has(comboKey(deck, stake))) return false;
    if (maxPerDeck !== undefined && (deckCount.get(deck) ?? 0) >= maxPerDeck) return false;
    if (maxPerStake !== undefined && (stakeCount.get(stake) ?? 0) >= maxPerStake) return false;
    return true;
  };
  const place = (deck: string, stake: string): void => {
    pool.push({ deck, stake });
    used.add(comboKey(deck, stake));
    deckCount.set(deck, (deckCount.get(deck) ?? 0) + 1);
    stakeCount.set(stake, (stakeCount.get(stake) ?? 0) + 1);
  };

  // Phase 1: reserve guarantees, most-constrained (largest min) first so a
  // later, looser guarantee never starves an earlier, tighter one out of the
  // decks it needs.
  const guarantees = mergeGuaranteedStakes(poolPolicy.guaranteedStakes ?? [])
    .filter((g) => enabledStakes.includes(g.stake))
    .sort((a, b) => b.min - a.min || a.stake.localeCompare(b.stake));

  for (const g of guarantees) {
    const need = g.min - (stakeCount.get(g.stake) ?? 0);
    for (let i = 0; i < need; i++) {
      const eligible = usableDecks.filter((d) => canUse(d, g.stake));
      if (eligible.length === 0) {
        throw new Error(
          `Could not satisfy the guarantee of ${g.min} for stake "${g.stake}" -- ran out of eligible decks ` +
            "under the current caps. checkPoolPolicyFeasibility should have caught this before generation; " +
            "treat this as a bug if it's reachable from a live config.",
        );
      }
      place(weightedPickFrom(eligible, rand, (d) => weightFor(d, deckWeights)), g.stake);
    }
  }

  // Phase 2: fill the remainder from every still-eligible combo, weighted by
  // deck x stake weight together.
  while (pool.length < size) {
    const candidates: DeckEntry[] = [];
    for (const deck of usableDecks) {
      if (maxPerDeck !== undefined && (deckCount.get(deck) ?? 0) >= maxPerDeck) continue;
      for (const stake of enabledStakes) {
        if (canUse(deck, stake)) candidates.push({ deck, stake });
      }
    }
    if (candidates.length === 0) {
      throw new Error(
        `Could not fill the pool to size ${size} (reached ${pool.length}) under the current policy -- ran ` +
          "out of eligible deck+stake combos. checkPoolPolicyFeasibility should have caught this before " +
          "generation; treat this as a bug if it's reachable from a live config.",
      );
    }
    const picked = weightedPickFrom(
      candidates,
      rand,
      (c) => weightFor(c.deck, deckWeights) * stakeWeightFor(c.stake, stakeWeights),
    );
    place(picked.deck, picked.stake);
  }

  return pool;
}
