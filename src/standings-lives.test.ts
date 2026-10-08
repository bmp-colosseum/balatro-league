import { describe, it, expect } from "vitest";
import type { Player } from "@prisma/client";
import type { PairingGameLives, PairingWithLives, StandingRow } from "./standings.js";
import { attachLivesToTiedRows } from "./standings-lives.js";

const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;

const G = (winnerId: string | null, winnerLives: number | null): PairingGameLives => ({ winnerId, winnerLives });

const M = (
  playerAId: string,
  playerBId: string,
  gamesWonA: number,
  gamesWonB: number,
  games?: PairingGameLives[],
): PairingWithLives => ({ playerAId, playerBId, gamesWonA, gamesWonB, games });

// Bare row builder -- only the fields attachLivesToTiedRows reads/writes
// (player.id, tiedWithPrev) plus whatever a real StandingRow needs to typecheck.
function row(id: string, overrides: Partial<StandingRow> = {}): StandingRow {
  return {
    player: P(id, id),
    points: 0, wins: 0, draws: 0, losses: 0, gamesWon: 0, gamesLost: 0, played: 0,
    ...overrides,
  };
}

describe("attachLivesToTiedRows", () => {
  it("no ties -> rows unchanged, no netLives keys added anywhere", () => {
    const rows = [row("a"), row("b"), row("c")];
    const pairings = [M("a", "b", 2, 0, [G("a", 5)])];
    const result = attachLivesToTiedRows(rows, pairings);
    for (const r of result) {
      expect(r.netLives).toBeUndefined();
      expect(r.livesGamesMissing).toBeUndefined();
      expect("netLives" in r).toBe(false);
    }
  });

  it("a 2-way tie gets netLives on both tied rows; an untied row after it is untouched", () => {
    const rows = [
      row("a"),
      row("b", { tiedWithPrev: true }), // b tied with a -- the 2-way group
      row("c"), // not tied with b -- untouched
    ];
    const pairings = [
      M("a", "x", 2, 0, [G("a", 3)]),
      M("b", "x", 2, 0, [G("b", 7)]),
    ];
    const result = attachLivesToTiedRows(rows, pairings);
    expect(result[0]!.netLives).toBe(3);
    expect(result[1]!.netLives).toBe(7);
    expect(result[2]!.netLives).toBeUndefined();
    expect("netLives" in result[2]!).toBe(false);
  });

  it("a 3-way tie gets netLives on all three rows; the next untied row is untouched", () => {
    const rows = [
      row("d"),
      row("e", { tiedWithPrev: true }),
      row("f", { tiedWithPrev: true }),
      row("g"), // not tied with f -- untouched
    ];
    const pairings = [
      M("d", "x", 2, 0, [G("d", 1)]),
      M("e", "x", 2, 0, [G("e", 2)]),
      M("f", "x", 2, 0, [G("f", 3)]),
    ];
    const result = attachLivesToTiedRows(rows, pairings);
    expect(result[0]!.netLives).toBe(1);
    expect(result[1]!.netLives).toBe(2);
    expect(result[2]!.netLives).toBe(3);
    expect(result[3]!.netLives).toBeUndefined();
    expect("netLives" in result[3]!).toBe(false);
  });

  it("a counted game missing winnerLives contributes 0 and is flagged via livesGamesMissing", () => {
    const rows = [row("a"), row("b", { tiedWithPrev: true })];
    const pairings = [M("a", "b", 2, 0, [G("a", null)])];
    const result = attachLivesToTiedRows(rows, pairings);
    expect(result[0]!.netLives).toBe(0);
    expect(result[0]!.livesGamesMissing).toBe(1);
    expect(result[1]!.netLives).toBe(0);
    expect(result[1]!.livesGamesMissing).toBe(1);
  });
});
