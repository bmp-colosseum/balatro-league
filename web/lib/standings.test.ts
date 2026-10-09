import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Player } from "@prisma/client";
import {
  computeStandings,
  computeNetLives,
  type PairingGameLives,
  type PairingWithLives,
  type ShootoutInput,
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

  it("a 3-way tie that's ALSO equal on net lives stays a genuine shared-rank tie", () => {
    // Same shape as "breaks a three-way tie by net lives" above, but every
    // winner banked the same lives -- the group can't be separated, so all
    // three share a rank. wins/draws/name only pick a stable DISPLAY order,
    // they never break the tie.
    const players = [
      P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"),
      P("dave", "Dave"), P("eve", "Eve"), P("frank", "Frank"),
    ];
    const pairings = [
      M("alice", "dave", 2, 0, [G("alice", 2)]),
      M("bob", "eve", 2, 0, [G("bob", 2)]),
      M("carol", "frank", 2, 0, [G("carol", 2)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const top3 = lives.slice(0, 3);
    expect(ids(top3)).toEqual(["alice", "bob", "carol"]); // alphabetical display order
    expect(top3.map((r) => r.netLives)).toEqual([2, 2, 2]);
    expect(top3[0]!.tiedWithPrev).toBeFalsy();
    expect(top3[1]!.tiedWithPrev).toBe(true);
    expect(top3[2]!.tiedWithPrev).toBe(true);
    expect(top3.map((r) => r.rank)).toEqual([1, 1, 1]);
  });
});

describe("computeStandings -- tiebreak: lives -- exactly-two-tied group rule", () => {
  it("a confirmed shootout decides a 2-way tie regardless of net lives", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob")];
    const pairings: PairingWithLives[] = [];
    const shootouts: ShootoutInput[] = [{ playerAId: "alice", playerBId: "bob", winnerId: "bob" }];
    const lives = computeStandings(players, pairings, shootouts, undefined, "lives");
    expect(ids(lives)).toEqual(["bob", "alice"]);
    expect(lives.find((r) => r.player.id === "alice")!.tiedWithPrev).toBeFalsy();
  });

  it("the within-match lives differential decides a 2-way tie after a 2-0", () => {
    // Alice beats Bob 2-0 with a big lives swing; Alice's loss to Carol and
    // Bob's win over Dave keep them level on points (3 each) despite the
    // decisive result between them.
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("eve", "Eve"), P("dave", "Dave")];
    const pairings = [
      M("alice", "bob", 2, 0, [G("alice", 4), G("alice", 1)]), // h2h diff = +5 for alice
      M("alice", "carol", 0, 2), // alice's compensating loss
      M("carol", "eve", 1, 1),
      M("bob", "dave", 2, 0), // bob's compensating win
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    expect(alice.points).toBe(3);
    expect(bob.points).toBe(3);
    expect(lives.indexOf(alice)).toBeLessThan(lives.indexOf(bob));
    expect(alice.h2hLives).toBe(5);
    expect(bob.h2hLives).toBe(-5);
    expect(alice.netLives).toBe(5);
    expect(bob.netLives).toBe(-5);
    expect(bob.tiedWithPrev).toBeFalsy();
  });

  it("the within-match lives differential decides a 2-way tie even when the match itself was a 1-1 draw", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob")];
    const pairings = [M("alice", "bob", 1, 1, [G("alice", 5), G("bob", 2)])]; // h2h diff = +3 for alice
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    expect(ids(lives)).toEqual(["alice", "bob"]);
    expect(lives.find((r) => r.player.id === "alice")!.h2hLives).toBe(3);
    expect(lives.find((r) => r.player.id === "bob")!.h2hLives).toBe(-3);
    expect(lives.find((r) => r.player.id === "bob")!.tiedWithPrev).toBeFalsy();
  });

  it("falls back to total net lives when the within-match differential is exactly zero", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    const pairings = [
      M("alice", "bob", 1, 1, [G("alice", 3), G("bob", 3)]), // h2h diff = 0
      M("alice", "carol", 1, 1, [G("alice", 5)]), // alice's extra net lives
      M("bob", "dave", 1, 1), // bob's compensating draw, no lives
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    expect(alice.points).toBe(bob.points);
    expect(alice.h2hLives).toBe(0);
    expect(bob.h2hLives).toBe(0);
    expect(alice.netLives).toBe(5);
    expect(bob.netLives).toBe(0);
    expect(lives.indexOf(alice)).toBeLessThan(lives.indexOf(bob));
    expect(bob.tiedWithPrev).toBeFalsy();
  });

  it("falls back to total net lives when the two never played each other", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    const pairings = [
      M("alice", "carol", 2, 0, [G("alice", 1)]),
      M("bob", "dave", 2, 0, [G("bob", 3)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    expect(ids(lives).slice(0, 2)).toEqual(["bob", "alice"]);
    expect(lives.find((r) => r.player.id === "alice")!.tiedWithPrev).toBeFalsy();
    expect(lives.find((r) => r.player.id === "alice")!.netLives).toBe(1);
    expect(lives.find((r) => r.player.id === "bob")!.netLives).toBe(3);
  });

  it("a real, unbreakable 2-way tie when total net lives also match", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    const pairings = [
      M("alice", "carol", 2, 0, [G("alice", 4)]),
      M("bob", "dave", 2, 0, [G("bob", 4)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const top2 = lives.slice(0, 2);
    expect(ids(top2)).toEqual(["alice", "bob"]); // alphabetical display order
    expect(top2.map((r) => r.netLives)).toEqual([4, 4]);
    expect(top2[0]!.tiedWithPrev).toBeFalsy();
    expect(top2[1]!.tiedWithPrev).toBe(true);
    expect(top2.map((r) => r.rank)).toEqual([1, 1]);
  });

  it("differing wins/draws don't break a lives-mode tie -- unlike chain mode", () => {
    // Alice: one win (3pts, 1W-0D). Bob: three draws (1pt each = 3pts, 0W-3D).
    // Equal points, equal (zero) net lives, never played each other -- a
    // REAL tie in lives mode even though wins differ. Under chain mode
    // today's tiebreak would have used wins to separate them; lives mode
    // must not.
    const players = [
      P("alice", "Alice"), P("bob", "Bob"),
      P("c", "C"), P("d", "D"), P("e", "E"), P("f", "F"),
    ];
    const pairings = [
      M("alice", "c", 2, 0),
      M("bob", "d", 1, 1),
      M("bob", "e", 1, 1),
      M("bob", "f", 1, 1),
    ];
    const chain = computeStandings(players, pairings);
    const chainTop2 = chain.slice(0, 2);
    expect(ids(chainTop2)).toEqual(["alice", "bob"]);
    expect(chainTop2.some((r) => r.tiedWithPrev)).toBe(false); // chain breaks it via wins

    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const livesTop2 = lives.slice(0, 2);
    expect(ids(livesTop2)).toEqual(["alice", "bob"]); // display order: more wins first
    expect(livesTop2.map((r) => r.netLives)).toEqual([0, 0]);
    expect(livesTop2[0]!.tiedWithPrev).toBeFalsy();
    expect(livesTop2[1]!.tiedWithPrev).toBe(true);
    expect(livesTop2.map((r) => r.rank)).toEqual([1, 1]);
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

describe("computeStandings -- tiebreak: lives -- tiebreakNote audit", () => {
  it("a shootout decided a 2-way tie -- note on both rows", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob")];
    const shootouts: ShootoutInput[] = [{ playerAId: "alice", playerBId: "bob", winnerId: "bob" }];
    const lives = computeStandings(players, [], shootouts, undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    expect(bob.tiebreakNote).toBe("Tied on points with Alice; shootout decided it");
    expect(alice.tiebreakNote).toBe("Tied on points with Bob; shootout decided it");
  });

  it("head-to-head lives decided a 2-way tie after a 1-1 -- signed numbers, own value first", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("eve", "Eve"), P("dave", "Dave")];
    const pairings = [
      M("alice", "bob", 1, 1, [G("alice", 4), G("bob", 1)]), // h2h diff = +3 for alice (1-1, so no outright win)
      M("alice", "carol", 2, 0), // alice to 4 points
      M("carol", "eve", 1, 1), // keeps carol out of alice/bob's points group
      M("bob", "dave", 2, 0), // bob to 4 points
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    expect(alice.tiebreakNote).toBe("Tied on points with Bob; head-to-head lives +3 vs -3 decided it");
    expect(bob.tiebreakNote).toBe("Tied on points with Alice; head-to-head lives -3 vs +3 decided it");
  });

  it("total net lives decided a 2-way tie after the within-match differential was exactly zero", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    const pairings = [
      M("alice", "bob", 1, 1, [G("alice", 3), G("bob", 3)]), // h2h diff = 0
      M("alice", "carol", 1, 1, [G("alice", 5)]),
      M("bob", "dave", 1, 1),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    expect(alice.tiebreakNote).toBe("Tied on points with Bob; total net lives decided it (5 / 0)");
    expect(bob.tiebreakNote).toBe("Tied on points with Alice; total net lives decided it (5 / 0)");
  });

  it("total net lives decided a 2-way tie when the two never played each other", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    const pairings = [
      M("alice", "carol", 2, 0, [G("alice", 1)]),
      M("bob", "dave", 2, 0, [G("bob", 3)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    expect(bob.tiebreakNote).toBe("Tied on points with Alice; total net lives decided it (3 / 1)");
    expect(alice.tiebreakNote).toBe("Tied on points with Bob; total net lives decided it (3 / 1)");
  });

  it("a real, unbreakable 2-way tie -- 'shares the place' note on both rows", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    const pairings = [
      M("alice", "carol", 2, 0, [G("alice", 4)]),
      M("bob", "dave", 2, 0, [G("bob", 4)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    expect(alice.tiebreakNote).toBe("Tied with Bob on points and net lives -- shares the place");
    expect(bob.tiebreakNote).toBe("Tied with Alice on points and net lives -- shares the place");
  });

  it("total net lives decided a fully-separated three-way tie -- note lists every other name and the whole group's final-order lives", () => {
    const players = [
      P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"),
      P("dave", "Dave"), P("eve", "Eve"), P("frank", "Frank"),
    ];
    const pairings = [
      M("alice", "dave", 2, 0, [G("alice", 5)]),
      M("bob", "eve", 2, 0, [G("bob", 3)]),
      M("carol", "frank", 2, 0, [G("carol", 1)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    const carol = lives.find((r) => r.player.id === "carol")!;
    expect(alice.tiebreakNote).toBe("Tied on points with Bob and Carol; total net lives decided it (5 / 3 / 1)");
    expect(bob.tiebreakNote).toBe("Tied on points with Alice and Carol; total net lives decided it (5 / 3 / 1)");
    expect(carol.tiebreakNote).toBe("Tied on points with Alice and Bob; total net lives decided it (5 / 3 / 1)");
  });

  it("a real three-way tie (also equal on net lives) -- 'shares the place' names only the other two", () => {
    const players = [
      P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"),
      P("dave", "Dave"), P("eve", "Eve"), P("frank", "Frank"),
    ];
    const pairings = [
      M("alice", "dave", 2, 0, [G("alice", 2)]),
      M("bob", "eve", 2, 0, [G("bob", 2)]),
      M("carol", "frank", 2, 0, [G("carol", 2)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    const carol = lives.find((r) => r.player.id === "carol")!;
    expect(alice.tiebreakNote).toBe("Tied with Bob and Carol on points and net lives -- shares the place");
    expect(bob.tiebreakNote).toBe("Tied with Alice and Carol on points and net lives -- shares the place");
    expect(carol.tiebreakNote).toBe("Tied with Alice and Bob on points and net lives -- shares the place");
  });

  it("a mixed four-way group: one decided row, two sharing a real tie, one more decided row", () => {
    // Points-tied group of 4 (alice/bob/carol/dave), net lives: 10 / 5 / 5 / 1.
    // Alice and dave are each uniquely placed by net lives; bob and carol
    // remain genuinely tied with each other.
    const players = [
      P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave"),
      P("w", "W"), P("x", "X"), P("y", "Y"), P("z", "Z"),
    ];
    const pairings = [
      M("alice", "w", 2, 0, [G("alice", 10)]),
      M("bob", "x", 2, 0, [G("bob", 5)]),
      M("carol", "y", 2, 0, [G("carol", 5)]),
      M("dave", "z", 2, 0, [G("dave", 1)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    const carol = lives.find((r) => r.player.id === "carol")!;
    const dave = lives.find((r) => r.player.id === "dave")!;
    expect(alice.tiebreakNote).toBe("Tied on points with Bob, Carol and Dave; total net lives decided it (10 / 5 / 5 / 1)");
    expect(dave.tiebreakNote).toBe("Tied on points with Alice, Bob and Carol; total net lives decided it (10 / 5 / 5 / 1)");
    expect(bob.tiebreakNote).toBe("Tied with Carol on points and net lives -- shares the place");
    expect(carol.tiebreakNote).toBe("Tied with Bob on points and net lives -- shares the place");
  });

  it("never sets tiebreakNote for a row alone on its points, even under tiebreak lives", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob")];
    const pairings = [M("alice", "bob", 2, 0)];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    expect(lives.every((r) => r.tiebreakNote === undefined)).toBe(true);
  });

  it("never sets tiebreakNote under the default chain tiebreak, even for a tied group", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    const pairings = [
      M("alice", "carol", 2, 0, [G("alice", 4)]),
      M("bob", "dave", 2, 0, [G("bob", 4)]),
    ];
    const chain = computeStandings(players, pairings);
    expect(chain.every((r) => r.tiebreakNote === undefined)).toBe(true);
  });
});

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

describe("lives tiebreak: a 2-0 head-to-head win settles a two-way tie outright", () => {
  it("wins even when no lives were recorded for that match", () => {
    // Alice beat Bob 2-0 with no lives data; both otherwise level on 3 points.
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("eve", "Eve"), P("dave", "Dave")];
    const pairings = [
      M("alice", "bob", 2, 0), // no games -> no h2h lives, but a clear 2-0
      M("alice", "carol", 0, 2),
      M("carol", "eve", 1, 1),
      M("bob", "dave", 2, 0),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const alice = lives.find((r) => r.player.id === "alice")!;
    const bob = lives.find((r) => r.player.id === "bob")!;
    expect(alice.points).toBe(3);
    expect(bob.points).toBe(3);
    expect(lives.indexOf(alice)).toBeLessThan(lives.indexOf(bob));
    expect(bob.tiedWithPrev).toBeFalsy();
    expect(alice.tiebreakNote).toBe("Tied on points with Bob; beat them head-to-head");
    expect(bob.tiebreakNote).toBe("Tied on points with Alice; lost to them head-to-head");
  });

  it("a 1-1 head-to-head does not count as a win; lives inside the match decide instead", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob")];
    const pairings = [M("alice", "bob", 1, 1, [G("alice", 2), G("bob", 4)])]; // bob +2 inside the match
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    expect(ids(lives)).toEqual(["bob", "alice"]);
    expect(lives[0]!.tiebreakNote).toContain("head-to-head lives");
  });
});
