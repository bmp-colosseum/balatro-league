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
  bans: number[];         // indices into pool that have been banned
  pickedDeckIdx?: number; // which remaining combo was picked
  winnerId?: string;
}

export function emptyGameState(firstId: string): GameState {
  return { firstId, bans: [] };
}

// How many bans the second player makes, and the first player's two ban steps.
// 9-pool: first bans 1, second bans 3, first bans 3, first picks 1 of 2 left.
//   First player total bans: 4. Second player total bans: 3. Picks: 1.
export const FIRST_PLAYER_BAN_TOTAL = 4;  // 1 then 3
export const SECOND_PLAYER_BAN_TOTAL = 3;
export const PICKS = 1;

export type Phase =
  | { kind: "BAN"; whoseBanId: string; remainingForThem: number; totalDone: number }
  | { kind: "PICK"; pickerId: string }
  | { kind: "PLAYING" }
  | { kind: "DONE" };

// Given current game state + the two player IDs in this match, return what
// phase the game is in and who's acting. Used to render the embed + decide
// which buttons are clickable.
export function phaseFor(
  game: GameState,
  playerAId: string,
  playerBId: string,
  poolSize: number,
): Phase {
  const otherId = game.firstId === playerAId ? playerBId : playerAId;
  const banCount = game.bans.length;
  if (game.winnerId) return { kind: "DONE" };
  if (game.pickedDeckIdx !== undefined) return { kind: "PLAYING" };

  // First-player ban 1 step
  if (banCount === 0) {
    return { kind: "BAN", whoseBanId: game.firstId, remainingForThem: 1, totalDone: 0 };
  }
  // Second-player ban 3 steps
  if (banCount >= 1 && banCount < 1 + SECOND_PLAYER_BAN_TOTAL) {
    const done = banCount - 1;
    return {
      kind: "BAN",
      whoseBanId: otherId,
      remainingForThem: SECOND_PLAYER_BAN_TOTAL - done,
      totalDone: banCount,
    };
  }
  // First-player ban 3 more
  if (banCount >= 1 + SECOND_PLAYER_BAN_TOTAL && banCount < 1 + SECOND_PLAYER_BAN_TOTAL + 3) {
    const done = banCount - (1 + SECOND_PLAYER_BAN_TOTAL);
    return {
      kind: "BAN",
      whoseBanId: game.firstId,
      remainingForThem: 3 - done,
      totalDone: banCount,
    };
  }
  // All bans done — SECOND player picks
  if (banCount >= poolSize - 2) {
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
