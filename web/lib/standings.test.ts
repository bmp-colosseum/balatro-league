import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Player } from "@prisma/client";
import {
  computeStandings,
  computeNetLives,
  type PairingGameLives,
  type PairingWithLives,
} from "./standings";

// computeStandings only reads id + displayName off Player.
const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;

// One decisive game between the pairing's two players: who won, and their
// remaining lives (null = not recorded -- the livesGamesMissing case).
const G = (winnerId: string | null, winnerLives: number | null): PairingGameLives => ({ winnerId, winnerLives });

const M = (
  playerAId: string,
  playerBId: string,
  gamesWonA: number,
  gamesWonB: number,
  games?: PairingGameLives[],
): PairingWithLives => ({ playerAId, playerBId, gamesWonA, gamesWonB, games });

const ids = (rows: { player: Player }[]) => rows.map((r) => r.player.id);

describe("computeNetLives", () => {
  it("sums the winner's lives in wins, subtracts the winner's lives in losses", () => {
    const pairings = [
      M("a", "b", 2, 0, [G("a", 3)]),
      M("a", "c", 0, 2, [G("c", 2)]),
    ];
    expect(computeNetLives("a", pairings)).toEqual({ netLives: 1, livesGamesMissing: 0 }); // +3 - 2
  });

  it("skips indeterminate games (no winnerId) and flags missing-lives games separately", () => {
    const pairings = [
      M("a", "b", 2, 0, [G("a", null)]), // decisive, lives not recorded -- missing
      M("a", "c", 2, 0, [G(null, null)]), // indeterminate -- skipped entirely
    ];
    expect(computeNetLives("a", pairings)).toEqual({ netLives: 0, livesGamesMissing: 1 });
  });

  it("ignores pairings the player isn't part of", () => {
    const pairings = [M("x", "y", 2, 0, [G("x", 5)])];
    expect(computeNetLives("a", pairings)).toEqual({ netLives: 0, livesGamesMissing: 0 });
  });
});

describe("computeStandings -- tiebreak: chain (default, unchanged)", () => {
  it("ignores any attached games data -- same order/ties as without it", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol")];
    const pairings = [M("alice", "carol", 2, 0, [G("alice", 1)]), M("bob", "carol", 2, 0, [G("bob", 9)])];
    const rows = computeStandings(players, pairings);
    for (const r of rows) {
      expect(r.netLives).toBeUndefined();
      expect(r.livesGamesMissing).toBeUndefined();
    }
  });
});

describe("computeStandings -- tiebreak: lives", () => {
  it("breaks a two-way tie by net lives (higher first)", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    // Alice and Bob each have one 2-0 win (3pts, 1-0-0), never play each
    // other -- tied on everything except net lives. Bob's win banked more
    // remaining lives, so under "lives" Bob should outrank Alice even though
    // Alice sorts first alphabetically (today's chain tiebreak).
    const pairings = [
      M("alice", "carol", 2, 0, [G("alice", 1)]),
      M("bob", "dave", 2, 0, [G("bob", 3)]),
    ];

    const chain = computeStandings(players, pairings);
    expect(ids(chain).slice(0, 2)).toEqual(["alice", "bob"]); // alphabetical, tied
    expect(chain.find((r) => r.player.id === "bob")!.tiedWithPrev).toBe(true);

    const lives = computeStandings(players, pairings, [], undefined, "lives");
    expect(ids(lives).slice(0, 2)).toEqual(["bob", "alice"]); // reordered by net lives
    expect(lives.find((r) => r.player.id === "alice")!.tiedWithPrev).toBeFalsy();
    expect(lives.find((r) => r.player.id === "alice")!.netLives).toBe(1);
    expect(lives.find((r) => r.player.id === "bob")!.netLives).toBe(3);
  });

  it("breaks a three-way tie by net lives", () => {
    const players = [
      P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"),
      P("dave", "Dave"), P("eve", "Eve"), P("frank", "Frank"),
    ];
    // Alice/Bob/Carol each have exactly one 2-0 win over a different fourth
    // player, never playing each other -- a genuine 3-way chain tie.
    const pairings = [
      M("alice", "dave", 2, 0, [G("alice", 5)]),
      M("bob", "eve", 2, 0, [G("bob", 3)]),
      M("carol", "frank", 2, 0, [G("carol", 1)]),
    ];

    const chain = computeStandings(players, pairings);
    const top3Chain = chain.slice(0, 3);
    expect(ids(top3Chain)).toEqual(["alice", "bob", "carol"]); // alphabetical
    expect(top3Chain.every((r) => r.tiedWithPrev || r.tiedWithNext)).toBe(true);

    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const top3Lives = lives.slice(0, 3);
    expect(ids(top3Lives)).toEqual(["alice", "bob", "carol"]); // net lives happens to match alpha here
    expect(top3Lives.some((r) => r.tiedWithPrev)).toBe(false); // fully separated now
    expect(top3Lives.map((r) => r.netLives)).toEqual([5, 3, 1]);
  });

  it("a game missing winnerLives contributes 0 and is flagged, not dropped silently", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob")];
    const pairings = [M("alice", "bob", 2, 0, [G("alice", null)])];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    expect(alice.netLives).toBe(0);
    expect(alice.livesGamesMissing).toBe(1);
  });
});

// ---- Property tests -------------------------------------------------------

const RESULT = fc.constantFrom<[number, number] | null>([2, 0], [0, 2], [1, 1], null);

function pairIndices(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

const playersFor = (n: number): Player[] => Array.from({ length: n }, (_, i) => P(`p${i}`, `Player${i}`));

// A full round robin of n players with random results; each decisive
// pairing gets one synthetic game with a random (possibly missing)
// winnerLives -- computeNetLives just sums across games, so one game per
// decisive pairing is enough to exercise every branch.
function pairingsArbitrary(n: number) {
  const idx = pairIndices(n);
  return fc
    .array(RESULT, { minLength: idx.length, maxLength: idx.length })
    .chain((results) =>
      fc
        .array(fc.option(fc.nat({ max: 5 }), { nil: null }), { minLength: idx.length, maxLength: idx.length })
        .map((livesForPair) =>
          idx
            .map(([i, j], k): PairingWithLives | null => {
              const r = results[k];
              if (!r) return null;
              const [a, b] = r;
              const playerAId = `p${i}`;
              const playerBId = `p${j}`;
              if (a === b) return M(playerAId, playerBId, a, b); // draw -- no decisive game
              const winnerId = a > b ? playerAId : playerBId;
              return M(playerAId, playerBId, a, b, [G(winnerId, livesForPair[k] ?? null)]);
            })
            .filter((p): p is PairingWithLives => p !== null),
        ),
    );
}

const nAndPairings = fc.integer({ min: 2, max: 6 }).chain((n) => fc.tuple(fc.constant(n), pairingsArbitrary(n)));

describe("computeStandings -- properties", () => {
  it("chain mode's output is identical whether or not pairings carry games data", () => {
    fc.assert(
      fc.property(nAndPairings, ([n, pairings]) => {
        const players = playersFor(n);
        const withGames = computeStandings(players, pairings);
        const withoutGames = computeStandings(
          players,
          pairings.map((p) => ({ playerAId: p.playerAId, playerBId: p.playerBId, gamesWonA: p.gamesWonA, gamesWonB: p.gamesWonB })),
        );
        expect(withGames).toEqual(withoutGames);
      }),
    );
  });

  it("under tiebreak lives, points order is never violated", () => {
    fc.assert(
      fc.property(nAndPairings, ([n, pairings]) => {
        const players = playersFor(n);
        const rows = computeStandings(players, pairings, [], undefined, "lives");
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i - 1]!.points).toBeGreaterThanOrEqual(rows[i]!.points);
        }
      }),
    );
  });
});
