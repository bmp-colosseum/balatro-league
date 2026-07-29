// Pure decision logic for deck/stake pool weighting + policy configuration
// (functional core -- no prisma/DB/I-O). Parses and validates the JSON-as-
// text deckWeights/poolPolicy MatchConfigPreset columns an admin edits at
// /admin/deck-bans, and checks whether a proposed configuration can actually
// fill its own pool -- delegating the real math to match-pool.ts's
// checkPoolPolicyFeasibility (the SAME engine that will actually generate
// the pool) rather than reimplementing it here, so this check and
// generatePool's own throw-on-infeasible guard can never disagree.
//
// Ported from balatro-team-tour's apps/tour/lib/deck-pool-config-core.ts,
// adapted to this app's own types/engine (./match-pool.ts) and to the
// league's real deck/stake MEMBERSHIP model: unlike Tour (where every deck
// is always "in the catalogue" and weight<=0 is the only exclusion
// mechanism), a league MatchConfigPreset's decks/stakes are already a real,
// independently-editable list (see web/app/admin/deck-bans/actions.ts's
// addDeck/removeDeck/addStake/removeStake) -- so this module takes that
// list as an input rather than deriving it from a fixed catalogue, and
// drops Tour's stakeMaxes/StakeMax knob entirely: this app's
// checkPoolPolicyFeasibility/generatePool have no per-stake-ceiling concept
// to parse a value for.
//
// Synced verbatim to web/lib/deck-pool-config-core.ts (see
// web/scripts/sync-schema.mjs) so the admin editor's live feasibility check
// and the save-time server validation in web/app/admin/deck-bans/actions.ts
// run the EXACT same code the bot does.
import { isCanonicalDeck, isCanonicalStake } from "./balatro-info";
import { checkPoolPolicyFeasibility, type DeckWeight, type GuaranteedStake, type PoolPolicy, type StakeWeight } from "./match-pool";

export type { DeckWeight, GuaranteedStake, PoolPolicy, StakeWeight } from "./match-pool";

// Mirrors match-pool.ts's own DEFAULT_POOL_SIZE. Duplicated rather than
// imported as a VALUE so this module never pulls in match-config.ts's
// prisma-touching resolvers merely to read a constant -- match-pool.ts
// itself has no prisma import, so importing ITS value exports here would
// be safe too, but re-declaring one small constant keeps this file's own
// import list to exactly what it needs (types + the one feasibility
// function), same "duplicate the constant, not the decision" posture Tour's
// own core takes with match-core's DEFAULT_POOL_SIZE.
export const DEFAULT_POOL_SIZE = 9;

function weightFor(deck: string, weights: readonly DeckWeight[]): number {
  const found = weights.find((w) => w.deck === deck);
  return found ? found.weight : 1;
}

function stakeWeightFor(stake: string, weights: readonly StakeWeight[]): number {
  const found = weights.find((w) => w.stake === stake);
  return found ? found.weight : 1;
}

/**
 * Recovers a DeckWeight[] from an arbitrary stored/submitted value. Drops any
 * entry whose deck isn't canonical or whose weight isn't a finite number;
 * keeps every other entry as-is (including weight <= 0, a deliberate
 * exclusion). Never throws -- malformed/stale JSON degrades to "no
 * overrides" (fully uniform).
 */
export function parseDeckWeights(raw: unknown): DeckWeight[] {
  if (!Array.isArray(raw)) return [];
  const out: DeckWeight[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== "object") continue;
    const deck = (entry as Record<string, unknown>).deck;
    const weight = (entry as Record<string, unknown>).weight;
    if (typeof deck === "string" && isCanonicalDeck(deck) && typeof weight === "number" && Number.isFinite(weight)) {
      out.push({ deck, weight });
    }
  }
  return out;
}

/**
 * Recovers a StakeWeight[] from an arbitrary stored/submitted value --
 * mirrors parseDeckWeights exactly, but for stakes. Never throws.
 */
export function parseStakeWeights(raw: unknown): StakeWeight[] {
  if (!Array.isArray(raw)) return [];
  const out: StakeWeight[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== "object") continue;
    const stake = (entry as Record<string, unknown>).stake;
    const weight = (entry as Record<string, unknown>).weight;
    if (typeof stake === "string" && isCanonicalStake(stake) && typeof weight === "number" && Number.isFinite(weight)) {
      out.push({ stake, weight });
    }
  }
  return out;
}

/**
 * Recovers a GuaranteedStake[] from an arbitrary stored/submitted value.
 * Drops any entry whose stake isn't canonical or whose min isn't a finite
 * number > 0 (a min of 0 is a no-op, so it's dropped rather than kept as a
 * meaningless zero-floor entry). Never throws.
 */
export function parseGuaranteedStakes(raw: unknown): GuaranteedStake[] {
  if (!Array.isArray(raw)) return [];
  const out: GuaranteedStake[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== "object") continue;
    const stake = (entry as Record<string, unknown>).stake;
    const min = (entry as Record<string, unknown>).min;
    if (typeof stake === "string" && isCanonicalStake(stake) && typeof min === "number" && Number.isFinite(min) && min > 0) {
      out.push({ stake, min });
    }
  }
  return out;
}

/**
 * Recovers a PoolPolicy from an arbitrary stored/submitted value. Each field
 * is parsed independently and dropped (never included) if malformed -- a bad
 * maxPerDeck doesn't poison a valid guaranteedStakes list. Never throws.
 */
export function parsePoolPolicy(raw: unknown): PoolPolicy {
  if (raw == null || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const policy: PoolPolicy = {};
  if (typeof obj.maxPerDeck === "number" && Number.isInteger(obj.maxPerDeck) && obj.maxPerDeck > 0) {
    policy.maxPerDeck = obj.maxPerDeck;
  }
  if (typeof obj.maxPerStake === "number" && Number.isInteger(obj.maxPerStake) && obj.maxPerStake > 0) {
    policy.maxPerStake = obj.maxPerStake;
  }
  const guaranteedStakes = parseGuaranteedStakes(obj.guaranteedStakes);
  if (guaranteedStakes.length > 0) policy.guaranteedStakes = guaranteedStakes;
  const stakeWeights = parseStakeWeights(obj.stakeWeights);
  if (stakeWeights.length > 0) policy.stakeWeights = stakeWeights;
  return policy;
}

/**
 * Parses a MatchConfigPreset.deckWeights column (JSON-serialized
 * DeckWeight[], or null) into a validated DeckWeight[]. Malformed JSON
 * degrades to "no overrides" (fully uniform) rather than throwing -- same
 * contract as every other parse* here.
 */
export function parseDeckWeightsJson(raw: string | null): DeckWeight[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return parseDeckWeights(parsed);
}

/**
 * Parses a MatchConfigPreset.poolPolicy column (JSON-serialized PoolPolicy,
 * or null) into a validated PoolPolicy. Malformed JSON degrades to {} (no
 * policy knob active) rather than throwing.
 */
export function parsePoolPolicyJson(raw: string | null): PoolPolicy {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return parsePoolPolicy(parsed);
}

/** A MatchConfigPreset row as read back from the DB, before parsing. */
export interface PresetRow {
  decks: string[];
  stakes: string[];
  deckWeights: string | null;
  // Optional (not just nullable) so a caller/test predating this column can
  // still construct a PresetRow without it -- buildPoolConfig treats a
  // missing field the same as an explicit null (no policy).
  poolPolicy?: string | null;
}

export interface PoolConfig {
  decks: string[];
  stakes: string[];
  poolSize: number;
  deckWeights: DeckWeight[];
  poolPolicy: PoolPolicy;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  decks: [],
  stakes: [],
  poolSize: DEFAULT_POOL_SIZE,
  deckWeights: [],
  poolPolicy: {},
};

/**
 * Builds a PoolConfig from a resolved MatchConfigPreset row + a pool size
 * (the league's own poolSize is a global settings value, not a per-preset
 * column -- see web/lib/league-settings.ts -- so this always takes it as a
 * parameter rather than reading it off the row), or DEFAULT_POOL_CONFIG when
 * no preset is resolved at all.
 */
export function buildPoolConfig(preset: PresetRow | null, poolSize: number | null = null): PoolConfig {
  const size = Number.isInteger(poolSize) && (poolSize as number) > 0 ? (poolSize as number) : DEFAULT_POOL_SIZE;
  if (!preset) return { ...DEFAULT_POOL_CONFIG, poolSize: size };
  return {
    decks: preset.decks,
    stakes: preset.stakes,
    poolSize: size,
    deckWeights: parseDeckWeightsJson(preset.deckWeights),
    poolPolicy: parsePoolPolicyJson(preset.poolPolicy ?? null),
  };
}

export interface PoolFeasibility {
  enabledDeckCount: number;
  enabledStakeCount: number;
  maxCombos: number;
  feasible: boolean;
  // Every reason the config can't fill its own pool -- combo shortfall, a cap
  // too tight, an unsatisfiable guarantee, etc (see match-pool.ts's
  // checkPoolPolicyFeasibility). Empty when feasible.
  reasons: string[];
}

/**
 * Whether a (decks, stakes, deckWeights, poolSize, poolPolicy) combination
 * can actually fill a pool of `poolSize` combos. Delegates the real
 * feasibility math to match-pool.ts's checkPoolPolicyFeasibility (the engine
 * that will actually generate the pool) rather than reimplementing it here
 * -- this just derives the display-only enabledDeckCount/enabledStakeCount
 * so the save action can reject an infeasible config before it ever reaches
 * generatePool, which (correctly, for a deliberate weight<=0 exclusion or an
 * unmet cap/guarantee) throws rather than silently returning a SMALLER or
 * non-conforming pool.
 */
export function poolFeasibility(
  decks: readonly string[],
  stakes: readonly string[],
  deckWeights: readonly DeckWeight[],
  poolSize: number,
  poolPolicy: PoolPolicy = {},
): PoolFeasibility {
  const enabledDeckCount =
    deckWeights.length > 0 ? decks.filter((d) => weightFor(d, deckWeights) > 0).length : decks.length;
  const stakeWeights = poolPolicy.stakeWeights ?? [];
  const enabledStakeCount =
    stakeWeights.length > 0 ? stakes.filter((s) => stakeWeightFor(s, stakeWeights) > 0).length : stakes.length;
  const maxCombos = enabledDeckCount * enabledStakeCount;

  const result = checkPoolPolicyFeasibility([...decks], [...stakes], poolSize, deckWeights, poolPolicy);
  return { enabledDeckCount, enabledStakeCount, maxCombos, feasible: result.ok, reasons: result.reasons };
}

/** The shape an admin submission is validated against before it's ever persisted. */
export interface PoolConfigInput {
  decks: string[];
  stakes: string[];
  poolSize: number;
  deckWeights: DeckWeight[];
  // Optional richer policy knobs (see PoolPolicy) -- undefined/empty means
  // none of them are active, same "absent = today's behaviour" contract as
  // deckWeights above.
  maxPerDeck?: number;
  maxPerStake?: number;
  guaranteedStakes?: GuaranteedStake[];
  stakeWeights?: StakeWeight[];
}

export interface PoolConfigValidation extends PoolFeasibility {
  ok: boolean;
  errors: string[];
}

/**
 * Validates an admin's proposed pool configuration. Rejects anything not
 * shaped like real deck/stake names, requires at least one enabled deck and
 * stake, requires maxPerDeck/maxPerStake (when given) to be positive whole
 * numbers, and -- the "reachable mistake" this whole layer exists to catch
 * before it reaches generatePool -- rejects a config that can't fill its own
 * pool size under its own caps and guarantees (delegated to match-pool.ts's
 * checkPoolPolicyFeasibility via poolFeasibility above, so the specific
 * reason -- "4 stakes at max 2 each cannot fill a pool of 9" and the like --
 * comes from the same engine that will actually generate the pool). Always
 * returns a result (never throws); the save action throws off of `.errors`
 * itself when it needs a hard failure.
 */
export function validatePoolConfig(input: PoolConfigInput): PoolConfigValidation {
  const errors: string[] = [];

  if (!Number.isInteger(input.poolSize) || input.poolSize < 1) {
    errors.push("Pool size must be a positive whole number.");
  }

  const decks = input.decks.filter(isCanonicalDeck);
  if (decks.length === 0) errors.push("At least one deck must be enabled.");
  if (decks.length !== input.decks.length) errors.push("One or more submitted decks weren't recognized.");

  const stakes = input.stakes.filter(isCanonicalStake);
  if (stakes.length === 0) errors.push("At least one stake must be enabled.");
  if (stakes.length !== input.stakes.length) errors.push("One or more submitted stakes weren't recognized.");

  const deckWeights = input.deckWeights.filter((w) => isCanonicalDeck(w.deck) && Number.isFinite(w.weight));
  if (deckWeights.length !== input.deckWeights.length) {
    errors.push("One or more submitted deck weights weren't recognized.");
  }

  const stakeWeights = (input.stakeWeights ?? []).filter((w) => isCanonicalStake(w.stake) && Number.isFinite(w.weight));
  if (stakeWeights.length !== (input.stakeWeights ?? []).length) {
    errors.push("One or more submitted stake weights weren't recognized.");
  }

  const guaranteedStakes = (input.guaranteedStakes ?? []).filter(
    (g) => isCanonicalStake(g.stake) && Number.isFinite(g.min) && g.min > 0,
  );
  if (guaranteedStakes.length !== (input.guaranteedStakes ?? []).length) {
    errors.push("One or more submitted guaranteed stakes weren't recognized.");
  }

  if (input.maxPerDeck !== undefined && (!Number.isInteger(input.maxPerDeck) || input.maxPerDeck < 1)) {
    errors.push("Max per deck must be a positive whole number (or left blank for no cap).");
  }
  if (input.maxPerStake !== undefined && (!Number.isInteger(input.maxPerStake) || input.maxPerStake < 1)) {
    errors.push("Max per stake must be a positive whole number (or left blank for no cap).");
  }

  const poolPolicy: PoolPolicy = {
    ...(input.maxPerDeck !== undefined && Number.isInteger(input.maxPerDeck) && input.maxPerDeck >= 1
      ? { maxPerDeck: input.maxPerDeck }
      : {}),
    ...(input.maxPerStake !== undefined && Number.isInteger(input.maxPerStake) && input.maxPerStake >= 1
      ? { maxPerStake: input.maxPerStake }
      : {}),
    guaranteedStakes,
    stakeWeights,
  };

  const feasibility = poolFeasibility(
    decks,
    stakes,
    deckWeights,
    Number.isInteger(input.poolSize) ? input.poolSize : DEFAULT_POOL_SIZE,
    poolPolicy,
  );
  if (!feasibility.feasible) errors.push(...feasibility.reasons);

  return { ok: errors.length === 0, errors, ...feasibility };
}
