// Weekly ±2-seed pairing negotiation (design §6.2). A coinflip sets who sends
// (proposes) first; captains then alternate propose → respond, where the
// responder may only answer with a player within ±2 seeds of the proposed one.
// Used players are tracked; when the remaining players can't be completed under
// the ±2 rule, it's a dead-end → TO override.
//
// Pure + immutable: every transition returns a new state. The host persists the
// resulting pairs as TourSets and the live board streams over SSE.

export const SEED_WINDOW = 2;

export interface RosterPlayer {
  playerId: string;
  seed: number; // intra-team seed
}

export interface PairResult {
  aPlayerId: string;
  bPlayerId: string;
}

export interface PairingState {
  rosterA: readonly RosterPlayer[];
  rosterB: readonly RosterPlayer[];
  sendFirst: "A" | "B"; // coinflip winner proposes first
  pairs: readonly PairResult[]; // completed pairings
  pending?: { by: "A" | "B"; playerId: string; seed: number }; // awaiting a response
}

export type PairingError = { ok: false; reason: string };

const other = (t: "A" | "B"): "A" | "B" => (t === "A" ? "B" : "A");

export function initPairing(
  rosterA: readonly RosterPlayer[],
  rosterB: readonly RosterPlayer[],
  sendFirst: "A" | "B",
): PairingState {
  return { rosterA, rosterB, sendFirst, pairs: [] };
}

// Ids locked into a completed pair.
function pairedIds(state: PairingState): Set<string> {
  const s = new Set<string>();
  for (const p of state.pairs) {
    s.add(p.aPlayerId);
    s.add(p.bPlayerId);
  }
  return s;
}

function rosterOf(state: PairingState, team: "A" | "B"): readonly RosterPlayer[] {
  return team === "A" ? state.rosterA : state.rosterB;
}

// Players still in play for a team, NOT counting the pending proposal's reserve.
function remainingOf(state: PairingState, team: "A" | "B"): RosterPlayer[] {
  const used = pairedIds(state);
  return rosterOf(state, team).filter((p) => !used.has(p.playerId));
}

/** Players a team can still propose/answer with (excludes the pending reserve). */
export function availableOf(state: PairingState, team: "A" | "B"): RosterPlayer[] {
  const used = pairedIds(state);
  if (state.pending && state.pending.by === team) used.add(state.pending.playerId);
  return rosterOf(state, team).filter((p) => !used.has(p.playerId));
}

/** Whose turn to propose (when nothing is pending): sendFirst, flipping per pair. */
export function whoseProposeTurn(state: PairingState): "A" | "B" {
  return state.pairs.length % 2 === 0 ? state.sendFirst : other(state.sendFirst);
}

/** Available opponents within ±2 seeds of the pending proposal. */
export function eligibleResponses(state: PairingState): RosterPlayer[] {
  if (!state.pending) return [];
  const seed = state.pending.seed;
  return availableOf(state, other(state.pending.by)).filter(
    (p) => Math.abs(p.seed - seed) <= SEED_WINDOW,
  );
}

export function propose(
  state: PairingState,
  by: "A" | "B",
  playerId: string,
): { ok: true; state: PairingState } | PairingError {
  if (state.pending) return { ok: false, reason: "a proposal is already pending" };
  if (by !== whoseProposeTurn(state)) return { ok: false, reason: `not team ${by}'s turn to propose` };
  const player = availableOf(state, by).find((p) => p.playerId === playerId);
  if (!player) return { ok: false, reason: "player not available" };
  return { ok: true, state: { ...state, pending: { by, playerId, seed: player.seed } } };
}

export function respond(
  state: PairingState,
  responderPlayerId: string,
): { ok: true; state: PairingState; pair: PairResult } | PairingError {
  const pending = state.pending;
  if (!pending) return { ok: false, reason: "no proposal to respond to" };
  const responder = availableOf(state, other(pending.by)).find((p) => p.playerId === responderPlayerId);
  if (!responder) return { ok: false, reason: "responder not available" };
  if (Math.abs(responder.seed - pending.seed) > SEED_WINDOW) {
    return {
      ok: false,
      reason: `seed ${responder.seed} not within ±${SEED_WINDOW} of proposed seed ${pending.seed}`,
    };
  }
  const pair: PairResult =
    pending.by === "A"
      ? { aPlayerId: pending.playerId, bPlayerId: responder.playerId }
      : { aPlayerId: responder.playerId, bPlayerId: pending.playerId };
  return {
    ok: true,
    state: { rosterA: state.rosterA, rosterB: state.rosterB, sendFirst: state.sendFirst, pairs: [...state.pairs, pair] },
    pair,
  };
}

/**
 * How many pairs this matchup actually needs: the explicit target (the season's
 * teamSize — sets per matchup), bounded by what the rosters can field. Rosters can
 * be UNEQUAL (a drop, extra subs) — the surplus players simply sit out, they don't
 * make the matchup unfinishable. No explicit target -> pair as many as both sides can.
 */
function effectiveTarget(state: PairingState, target?: number): number {
  const cap = Math.min(state.rosterA.length, state.rosterB.length);
  return target != null ? Math.min(Math.max(0, Math.trunc(target)), cap) : cap;
}

/** Enough pairs for the matchup's sets and nothing pending. */
export function isComplete(state: PairingState, target?: number): boolean {
  return state.pairs.length >= effectiveTarget(state, target) && !state.pending;
}

/**
 * Whether the remaining (unpaired) players can still supply the pairs the matchup
 * needs — a bipartite matching of size >= (target − already-paired), where edge
 * (a,b) exists iff |a.seed − b.seed| ≤ 2. Kuhn's augmenting-path maximum matching
 * (rosters are small). NOT a perfect-matching test: unequal rosters or benched
 * surplus players are fine — only "can we reach the target?" matters. Ignores any
 * pending proposal — it answers "can what's left still be finished?".
 */
export function canCompleteMatching(state: PairingState, target?: number): boolean {
  const needed = effectiveTarget(state, target) - state.pairs.length;
  if (needed <= 0) return true;
  const A = remainingOf(state, "A");
  const B = remainingOf(state, "B");
  if (Math.min(A.length, B.length) < needed) return false;

  const adj: number[][] = A.map((a) =>
    B.reduce<number[]>((acc, b, j) => {
      if (Math.abs(a.seed - b.seed) <= SEED_WINDOW) acc.push(j);
      return acc;
    }, []),
  );

  const matchB = new Array<number>(B.length).fill(-1);
  const augment = (u: number, seen: boolean[]): boolean => {
    for (const v of adj[u]!) {
      if (seen[v]) continue;
      seen[v] = true;
      if (matchB[v] === -1 || augment(matchB[v]!, seen)) {
        matchB[v] = u;
        return true;
      }
    }
    return false;
  };

  let matched = 0;
  for (let u = 0; u < A.length; u++) {
    if (augment(u, new Array<boolean>(B.length).fill(false))) matched++;
  }
  return matched >= needed;
}

/** Not finished AND no valid completion exists → TO override needed (§6.2). */
export function isDeadlocked(state: PairingState, target?: number): boolean {
  return !isComplete(state, target) && !canCompleteMatching(state, target);
}
