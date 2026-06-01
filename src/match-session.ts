// Match session state machine.
//
// State transitions (button-driven from the Discord thread):
//
//   WAITING_ACCEPT  --opponent clicks Accept-->  GAME_1_BAN
//   GAME_1_BAN      --7 bans completed------->   GAME_1_PICK
//   GAME_1_PICK     --second picks 1 of 2---->   GAME_1_PLAYING
//   GAME_1_PLAYING  --winner button---------->   GAME_2_CHOOSE_FIRST
//   GAME_2_CHOOSE_FIRST --loser picks who---->   GAME_2_BAN
//   GAME_2_BAN      --7 bans completed------->   GAME_2_PICK
//   GAME_2_PICK     --second picks 1 of 2---->   GAME_2_PLAYING
//   GAME_2_PLAYING  --winner button---------->   COMPLETE (writes Pairing, fires announce)
//
// Ban order in each game:
//   - First player bans 1 (8 left)
//   - Second player bans 3 (5 left)
//   - First player bans 3 (2 left)
//   - SECOND player picks 1 of the 2 remaining. The first player banned 4
//     times total — they shaped the pool — so the second player gets the
//     final say on which of the two survives.

import type { DeckEntry } from "./match-config.js";

export interface GameState {
  firstId: string;        // who bans first in this game
  bans: number[];         // indices into THIS game's pool that have been banned
  pickedDeckIdx?: number; // which remaining combo was picked (index into this game's pool)
  winnerId?: string;      // confirmed winner (both players' votes agreed)
  // Per-game deck/stake pool. Generated fresh when this game starts so
  // game2 and game3 don't reuse game1's shuffle — bans reset to a new
  // random subset of the preset each round.
  pool: DeckEntry[];
  // Bans the current ban-acting player has selected in the multi-select
  // menu but not yet confirmed. Cleared when applied via the Confirm
  // button (or when the player re-selects in the menu).
  pendingBans?: number[];
  // Per-player winner votes. Both players vote independently; if they
  // agree the winner is recorded. If they disagree the match enters a
  // dispute state — admin uses /admin override-result to resolve.
  voteByA?: string;       // playerAId's vote (a discord-user-id-equivalent player.id)
  voteByB?: string;       // playerBId's vote
  // True once both votes are in AND disagree. UI shows dispute notice;
  // admin must resolve via /admin override-result before the match can
  // continue (or the match stays here forever).
  disputed?: boolean;
  // Reroll consent. Either player can request a pool reroll during the
  // ban phase; both must agree to apply. When both true, the pool is
  // regenerated, bans/pendingBans are cleared, and the votes reset.
  rerollVoteByA?: boolean;
  rerollVoteByB?: boolean;
  // Cancel-match consent during the ban phase (game 1 only). Same
  // mutual-consent pattern as reroll: first click registers a vote,
  // second click flips the session to CANCELLED. No DB cleanup beyond
  // that — the row sticks around for audit.
  cancelVoteByA?: boolean;
  cancelVoteByB?: boolean;
}

export function emptyGameState(firstId: string, pool: DeckEntry[]): GameState {
  return { firstId, bans: [], pool };
}

// Default ban counts when no policy is supplied. Real flows pass the
// session-stamped policy so admin tweaks don't disrupt in-flight games.
// Pattern: first bans 1, second bans SECOND_TOTAL, first bans
// (FIRST_TOTAL - 1), second picks from the remainder.
export const FIRST_PLAYER_BAN_TOTAL = 4;
export const SECOND_PLAYER_BAN_TOTAL = 3;
export const PICKS = 1;

// Policy snapshot — what's stamped on each MatchSession at create time.
// Stays static for that session even if the admin changes LeagueSettings
// mid-match. Reads back via parsePolicy(session.policy) ?? DEFAULTS.
export interface BanPickPolicy {
  firstPlayerBans: number;   // total bans across the first player's two ban steps
  secondPlayerBans: number;  // second player's single ban step
  poolSize: number;          // total combos in the generated pool
}

export const DEFAULT_POLICY: BanPickPolicy = {
  firstPlayerBans: FIRST_PLAYER_BAN_TOTAL,
  secondPlayerBans: SECOND_PLAYER_BAN_TOTAL,
  poolSize: 9,
};

export function parsePolicy(json: string | null): BanPickPolicy {
  if (!json) return DEFAULT_POLICY;
  try {
    const p = JSON.parse(json) as Partial<BanPickPolicy>;
    if (
      typeof p.firstPlayerBans === "number" &&
      typeof p.secondPlayerBans === "number" &&
      typeof p.poolSize === "number"
    ) {
      return {
        firstPlayerBans: p.firstPlayerBans,
        secondPlayerBans: p.secondPlayerBans,
        poolSize: p.poolSize,
      };
    }
  } catch {
    // fall through
  }
  return DEFAULT_POLICY;
}

export type Phase =
  | { kind: "BAN"; whoseBanId: string; remainingForThem: number; totalDone: number }
  | { kind: "PICK"; pickerId: string }
  | { kind: "PLAYING" }
  | { kind: "DONE" };

// Given current game state, player IDs, and the session's stamped ban
// policy, return what phase the game is in and who's acting. Used to
// render the embed + decide which buttons are clickable. Policy is read
// from MatchSession.policy at the call site (parsePolicy + pass in).
export function phaseFor(
  game: GameState,
  playerAId: string,
  playerBId: string,
  policy: BanPickPolicy,
): Phase {
  const otherId = game.firstId === playerAId ? playerBId : playerAId;
  const banCount = game.bans.length;
  const { firstPlayerBans, secondPlayerBans, poolSize } = policy;
  if (game.winnerId) return { kind: "DONE" };
  if (game.pickedDeckIdx !== undefined) return { kind: "PLAYING" };

  // Step 1: first player bans 1
  if (banCount === 0) {
    return { kind: "BAN", whoseBanId: game.firstId, remainingForThem: 1, totalDone: 0 };
  }
  // Step 2: second player bans secondPlayerBans
  if (banCount >= 1 && banCount < 1 + secondPlayerBans) {
    const done = banCount - 1;
    return {
      kind: "BAN",
      whoseBanId: otherId,
      remainingForThem: secondPlayerBans - done,
      totalDone: banCount,
    };
  }
  // Step 3: first player bans (firstPlayerBans - 1) more
  const remainingFirstBans = firstPlayerBans - 1;
  if (
    banCount >= 1 + secondPlayerBans &&
    banCount < 1 + secondPlayerBans + remainingFirstBans
  ) {
    const done = banCount - (1 + secondPlayerBans);
    return {
      kind: "BAN",
      whoseBanId: game.firstId,
      remainingForThem: remainingFirstBans - done,
      totalDone: banCount,
    };
  }
  // All bans done — second player picks from what's left
  const totalBans = firstPlayerBans + secondPlayerBans;
  const remaining = poolSize - totalBans;
  if (banCount >= totalBans && remaining >= 1) {
    return { kind: "PICK", pickerId: otherId };
  }
  // Shouldn't reach here
  return { kind: "PLAYING" };
}

export function remainingCombos(pool: DeckEntry[], bans: number[]): { idx: number; combo: DeckEntry }[] {
  const banned = new Set(bans);
  const out: { idx: number; combo: DeckEntry }[] = [];
  pool.forEach((combo, idx) => {
    if (!banned.has(idx)) out.push({ idx, combo });
  });
  return out;
}
