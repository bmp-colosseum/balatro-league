// Mirrors web/lib/standings-best-n.test.ts's core coverage -- the bypass
// case (so tiebreak: "lives" doesn't disturb the no-dropout path) plus the
// tiebreak: "lives" suite, which is new with this file.

import { describe, it, expect } from "vitest";
import type { Player } from "@prisma/client";
import { computeStandings } from "./standings.js";
import {
  computeBestNStandings,
  type BestNMemberInput,
  type BestNPairing,
} from "./standings-best-n.js";

// computeBestNStandings only reads id + displayName off Player.
const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;

const member = (
  id: string,
  displayName: string,
  opts: Partial<Omit<BestNMemberInput, "player">> = {},
): BestNMemberInput => ({
  player: P(id, displayName),
  status: opts.status ?? "ACTIVE",
  isReplacement: opts.isReplacement ?? false,
  scheduledGames: opts.scheduledGames ?? 0,
});

const M = (playerAId: string, playerBId: string, gamesWonA: number, gamesWonB: number): BestNPairing => ({
  playerAId,
  playerBId,
  gamesWonA,
  gamesWonB,
});

describe("computeBestNStandings -- no unreplaced dropout (bypass)", () => {
  it("matches computeStandings exactly when nobody dropped", () => {
    const members = [member("a", "Alice"), member("b", "Bob"), member("c", "Cara")];
    const pairings = [M("a", "b", 2, 0), M("a", "c", 1, 1), M("b", "c", 0, 2)];
    const result = computeBestNStandings(members, pairings);
    const plain = computeStandings(members.map((m) => m.player), pairings);

    expect(result.division).toEqual({ n: 2, k: 3, scheduled: 2, dropouts: 0 });
    for (const r of result.rows) {
      expect(r.counted).toBe(r.played);
      expect(r.of).toBe(r.played);
      expect(r.droppedResults).toEqual([]);
    }
    expect(result.rows.map((r) => r.player.id)).toEqual(plain.map((r) => r.player.id));
  });
});

describe("computeBestNStandings -- tiebreak: lives", () => {
  // Pairing with one synthetic decisive game carrying lives data (same
  // shape web/lib/loaders/standings-preview.ts builds from Game rows).
  const MG = (playerAId: string, playerBId: string, gamesWonA: number, gamesWonB: number, winnerId: string, winnerLives: number | null): BestNPairing => ({
    playerAId, playerBId, gamesWonA, gamesWonB, games: [{ winnerId, winnerLives }],
  });

  it("default (chain) ignores games data entirely -- no netLives on any row", () => {
    const members = [member("a", "Alice"), member("b", "Bob"), member("c", "Cara", { status: "DROPPED" })];
    const pairings = [MG("a", "b", 2, 0, "a", 5), MG("a", "c", 1, 1, "a", 1)];
    const result = computeBestNStandings(members, pairings);
    for (const r of result.rows) {
      expect(r.netLives).toBeUndefined();
      expect(r.livesGamesMissing).toBeUndefined();
    }
  });

  it("sums net lives from COUNTED results only -- a dropped result's lives don't count", () => {
    // 5 players (a, b, c, d active; x an unreplaced dropout) with no
    // scheduledGames override -> scheduled = k - 1 = 4, dropouts = 1,
    // so n = 3: both Alice and Bob play 4 games and count their best 3.
    // Alice's one loss (to Bob, who banked 9 lives winning it) is her worst
    // result and gets dropped -- that -9 swing must NOT reach her netLives,
    // even though the same game's +9 DOES count for Bob (a win for him).
    const members = [
      member("a", "Alice"), member("b", "Bob"), member("c", "Cara"), member("d", "Dan"),
      member("x", "Xan", { status: "DROPPED" }),
    ];
    const pairings = [
      MG("a", "c", 2, 0, "a", 1), MG("a", "d", 2, 0, "a", 1), MG("a", "x", 2, 0, "a", 1),
      MG("a", "b", 0, 2, "b", 9), // Alice's worst result (a loss) -- dropped from her best-3
      MG("b", "c", 2, 0, "b", 1), MG("b", "d", 2, 0, "b", 1),
      MG("b", "x", 0, 2, "x", 1), // Bob's worst result (a loss) -- dropped from his best-3
    ];
    const result = computeBestNStandings(members, pairings, [], undefined, "count", null, "lives");
    const alice = result.rows.find((r) => r.player.id === "a")!;
    const bob = result.rows.find((r) => r.player.id === "b")!;
    expect(alice.counted).toBe(3);
    expect(bob.counted).toBe(3);
    expect(alice.netLives).toBe(1 + 1 + 1); // her 3 wins vs c/d/x -- the loss to Bob is dropped
    expect(bob.netLives).toBe(9 + 1 + 1); // his win over Alice counts; his loss to x is dropped
  });

  it("a counted game missing winnerLives contributes 0 and is flagged via livesGamesMissing", () => {
    const members = [member("a", "Alice"), member("b", "Bob"), member("c", "Cara", { status: "DROPPED" })];
    const pairings: BestNPairing[] = [
      { playerAId: "a", playerBId: "b", gamesWonA: 2, gamesWonB: 0, games: [{ winnerId: "a", winnerLives: null }] },
      { playerAId: "a", playerBId: "c", gamesWonA: 1, gamesWonB: 1 },
    ];
    const result = computeBestNStandings(members, pairings, [], undefined, "count", null, "lives");
    const alice = result.rows.find((r) => r.player.id === "a")!;
    expect(alice.netLives).toBe(0);
    expect(alice.livesGamesMissing).toBe(1);
  });
});
