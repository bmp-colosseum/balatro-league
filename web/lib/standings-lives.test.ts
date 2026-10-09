import { describe, it, expect } from "vitest";
import type { Player } from "@prisma/client";
import type { PairingGameLives, PairingWithLives, StandingRow } from "./standings";
import { attachNetLives } from "./standings-lives";

const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;

const G = (winnerId: string | null, winnerLives: number | null): PairingGameLives => ({ winnerId, winnerLives });

const M = (
  playerAId: string,
  playerBId: string,
  gamesWonA: number,
  gamesWonB: number,
  games?: PairingGameLives[],
): PairingWithLives => ({ playerAId, playerBId, gamesWonA, gamesWonB, games });

// Bare row builder -- only the fields attachNetLives reads/writes
// (player.id, tiedWithPrev) plus whatever a real StandingRow needs to typecheck.
function row(id: string, overrides: Partial<StandingRow> = {}): StandingRow {
  return {
    player: P(id, id),
    points: 0, wins: 0, draws: 0, losses: 0, gamesWon: 0, gamesLost: 0, played: 0,
    ...overrides,
  };
}

describe("attachNetLives", () => {
  it("rows with nothing played are untouched, no netLives keys added", () => {
    const rows = [row("a"), row("b"), row("c")];
    const pairings = [M("a", "b", 2, 0, [G("a", 5)])];
    const result = attachNetLives(rows, pairings);
    for (const r of result) {
      expect(r.netLives).toBeUndefined();
      expect(r.livesGamesMissing).toBeUndefined();
      expect("netLives" in r).toBe(false);
    }
  });

  it("every row that has played gets netLives, tied or not", () => {
    const rows = [
      row("a", { played: 1 }),
      row("b", { played: 1, tiedWithPrev: true }),
      row("c", { played: 1 }), // not tied, still gets its lives
      row("d"), // nothing played -- untouched
    ];
    const pairings = [
      M("a", "x", 2, 0, [G("a", 3)]),
      M("b", "x", 2, 0, [G("b", 7)]),
      M("c", "x", 0, 2, [G("x", 4)]),
    ];
    const result = attachNetLives(rows, pairings);
    expect(result[0]!.netLives).toBe(3);
    expect(result[1]!.netLives).toBe(7);
    expect(result[2]!.netLives).toBe(-4);
    expect(result[3]!.netLives).toBeUndefined();
    expect("netLives" in result[3]!).toBe(false);
  });

  it("the two sides of one match mirror each other", () => {
    const rows = [row("a", { played: 1 }), row("b", { played: 1 })];
    const pairings = [M("a", "b", 2, 0, [G("a", 8)])];
    const result = attachNetLives(rows, pairings);
    expect(result[0]!.netLives).toBe(8);
    expect(result[1]!.netLives).toBe(-8);
  });

  it("a counted game missing winnerLives contributes 0 and is flagged via livesGamesMissing", () => {
    const rows = [row("a", { played: 1 }), row("b", { played: 1, tiedWithPrev: true })];
    const pairings = [M("a", "b", 2, 0, [G("a", null)])];
    const result = attachNetLives(rows, pairings);
    expect(result[0]!.netLives).toBe(0);
    expect(result[0]!.livesGamesMissing).toBe(1);
    expect(result[1]!.netLives).toBe(0);
    expect(result[1]!.livesGamesMissing).toBe(1);
  });
});
