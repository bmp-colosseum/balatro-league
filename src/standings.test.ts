import { describe, it, expect } from "vitest";
import type { Match, Player } from "@prisma/client";
import {
  computeStandings,
  type ShootoutInput,
  type PairingGameLives,
  type PairingWithLives,
} from "./standings.js";

// computeStandings only reads id + displayName off Player.
const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;

type PairingInput = Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">;
const M = (playerAId: string, playerBId: string, gamesWonA: number, gamesWonB: number): PairingInput => ({
  playerAId,
  playerBId,
  gamesWonA,
  gamesWonB,
});

// One decisive game between the pairing's two players: who won, and their
// remaining lives (null = not recorded -- the livesGamesMissing case).
// Mirrors web/lib/standings.test.ts's identical helper.
const G = (winnerId: string | null, winnerLives: number | null): PairingGameLives => ({ winnerId, winnerLives });

// Same as M, but carrying per-game lives data for the "lives" tiebreak.
const ML = (
  playerAId: string,
  playerBId: string,
  gamesWonA: number,
  gamesWonB: number,
  games?: PairingGameLives[],
): PairingWithLives => ({ playerAId, playerBId, gamesWonA, gamesWonB, games });

const ids = (rows: { player: Player }[]) => rows.map((r) => r.player.id);

describe("computeStandings — scoring & records", () => {
  it("returns one row per player with zeroed stats when no matches", () => {
    const rows = computeStandings([P("a", "Alice"), P("b", "Bob")], []);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ points: 0, wins: 0, draws: 0, losses: 0, gamesWon: 0, gamesLost: 0, played: 0 });
    }
  });

  it("awards 3-0 for a 2-0 win and tallies games + record", () => {
    const rows = computeStandings([P("a", "Alice"), P("b", "Bob")], [M("a", "b", 2, 0)]);
    const a = rows.find((r) => r.player.id === "a")!;
    const b = rows.find((r) => r.player.id === "b")!;
    expect(a).toMatchObject({ points: 3, wins: 1, losses: 0, gamesWon: 2, gamesLost: 0, played: 1 });
    expect(b).toMatchObject({ points: 0, wins: 0, losses: 1, gamesWon: 0, gamesLost: 2, played: 1 });
  });

  it("awards 1 point each for a 1-1 draw", () => {
    const rows = computeStandings([P("a", "Alice"), P("b", "Bob")], [M("a", "b", 1, 1)]);
    for (const r of rows) {
      expect(r).toMatchObject({ points: 1, draws: 1, wins: 0, losses: 0, played: 1 });
    }
  });

  it("accumulates across multiple matches", () => {
    const rows = computeStandings(
      [P("a", "Alice"), P("b", "Bob"), P("c", "Cara")],
      [M("a", "b", 2, 0), M("a", "c", 1, 1)],
    );
    const a = rows.find((r) => r.player.id === "a")!;
    expect(a).toMatchObject({ points: 4, wins: 1, draws: 1, losses: 0, gamesWon: 3, gamesLost: 1, played: 2 });
  });

  it("ignores malformed scores (not 2-0 / 1-1 / 0-2) for points but still counts games", () => {
    const rows = computeStandings([P("a", "Alice"), P("b", "Bob")], [M("a", "b", 2, 1)]);
    const a = rows.find((r) => r.player.id === "a")!;
    expect(a.points).toBe(0);
    expect(a.wins).toBe(0);
    expect(a.gamesWon).toBe(2); // games still tallied
    expect(a.played).toBe(1);
  });

  it("skips pairings that reference an unknown player", () => {
    const rows = computeStandings([P("a", "Alice"), P("b", "Bob")], [M("a", "ghost", 2, 0)]);
    expect(rows.find((r) => r.player.id === "a")!.played).toBe(0);
  });

  it("respects a custom scoring config", () => {
    const rows = computeStandings(
      [P("a", "Alice"), P("b", "Bob")],
      [M("a", "b", 2, 0)],
      [],
      { pointsFor20Win: 10, pointsFor11Draw: 5, pointsForLoss: 1 },
    );
    expect(rows.find((r) => r.player.id === "a")!.points).toBe(10);
    expect(rows.find((r) => r.player.id === "b")!.points).toBe(1);
  });
});

describe("computeStandings — sort & tiebreakers", () => {
  it("sorts by points descending", () => {
    const rows = computeStandings(
      [P("a", "Alice"), P("b", "Bob"), P("c", "Cara")],
      [M("a", "b", 2, 0), M("a", "c", 2, 0)], // a=6, b=0, c=0
    );
    expect(ids(rows)[0]).toBe("a");
  });

  it("breaks a points tie by head-to-head (2-0), overriding alphabetical", () => {
    // Zed and Alice both finish on 3; Zed beat Alice 2-0.
    const rows = computeStandings(
      [P("zed", "Zed"), P("ali", "Alice"), P("car", "Cara")],
      [M("zed", "ali", 2, 0), M("ali", "car", 2, 0)], // zed=3, ali=3, car=0
    );
    expect(ids(rows)).toEqual(["zed", "ali", "car"]);
  });

  it("breaks a points tie by showdown when head-to-head was a draw", () => {
    // Zed & Alice drew 1-1 (no h2h winner); a showdown says Zed wins.
    const players = [P("zed", "Zed"), P("ali", "Alice")];
    const pairings = [M("zed", "ali", 1, 1)]; // both on 1 point, h2h = draw
    const shootouts: ShootoutInput[] = [{ playerAId: "zed", playerBId: "ali", winnerId: "zed" }];
    const rows = computeStandings(players, pairings, shootouts);
    expect(ids(rows)).toEqual(["zed", "ali"]);
  });

  it("falls back to displayName when fully tied", () => {
    const rows = computeStandings([P("b", "Bravo"), P("a", "Alpha")], []);
    expect(ids(rows)).toEqual(["a", "b"]); // Alpha before Bravo
  });

  it("resolves a 3-way tie via a round-robin of showdowns (manual tie resolution)", () => {
    // Three players each drew the other two 1-1 → all tied on points, every
    // head-to-head a draw. The manual tie tool writes the round-robin of
    // showdowns encoding the desired order z > m > x; the pairwise shootout
    // tiebreaker must compose them into that exact finishing order — NOT the
    // alphabetical fallback (which would be m, x, z).
    const players = [P("x", "Mike"), P("m", "Nate"), P("z", "Owen")];
    const pairings = [M("x", "m", 1, 1), M("x", "z", 1, 1), M("m", "z", 1, 1)];
    const shootouts: ShootoutInput[] = [
      { playerAId: "z", playerBId: "m", winnerId: "z" },
      { playerAId: "z", playerBId: "x", winnerId: "z" },
      { playerAId: "m", playerBId: "x", winnerId: "m" },
    ];
    const rows = computeStandings(players, pairings, shootouts);
    expect(ids(rows)).toEqual(["z", "m", "x"]);
  });

  it("picks a 3-way tie winner while leaving the other two tied (no showdown between them)", () => {
    // All three tied on points. The winner (Carol) has a showdown over each of
    // the other two, but Alice & Bob have NO showdown between them — so they
    // stay tied and fall back to alphabetical. Carol still rises to the top.
    const players = [P("c", "Carol"), P("a", "Alice"), P("b", "Bob")];
    const pairings = [M("c", "a", 1, 1), M("c", "b", 1, 1), M("a", "b", 1, 1)];
    const shootouts: ShootoutInput[] = [
      { playerAId: "c", playerBId: "a", winnerId: "c" },
      { playerAId: "c", playerBId: "b", winnerId: "c" },
    ];
    const rows = computeStandings(players, pairings, shootouts);
    expect(ids(rows)).toEqual(["c", "a", "b"]); // Carol wins; Alice/Bob tied → alphabetical
  });

  it("gives genuinely-tied players a SHARED rank (standard competition ranking)", () => {
    // Alpha beats both; Bob & Cara draw each other → tied on everything.
    const players = [P("a", "Alpha"), P("b", "Bob"), P("c", "Cara")];
    const pairings = [M("a", "b", 2, 0), M("a", "c", 2, 0), M("b", "c", 1, 1)];
    const rows = computeStandings(players, pairings);
    // Order: Alpha (rank 1), then Bob & Cara tied (rank 2, 2).
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 2]);
    expect(rows[1]!.tiedWithNext).toBe(true); // Bob tied with the one below
    expect(rows[2]!.tiedWithPrev).toBe(true); // Cara tied with the one above
    expect(rows[0]!.tiedWithPrev).toBeUndefined(); // Alpha not tied
  });
});

describe("computeStandings -- tiebreak: lives -- 3+-way group rule", () => {
  it("breaks a three-way tie by total net lives", () => {
    const players = [
      P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"),
      P("dave", "Dave"), P("eve", "Eve"), P("frank", "Frank"),
    ];
    const pairings = [
      ML("alice", "dave", 2, 0, [G("alice", 5)]),
      ML("bob", "eve", 2, 0, [G("bob", 3)]),
      ML("carol", "frank", 2, 0, [G("carol", 1)]),
    ];
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    const top3 = lives.slice(0, 3);
    expect(ids(top3)).toEqual(["alice", "bob", "carol"]);
    expect(top3.some((r) => r.tiedWithPrev)).toBe(false);
    expect(top3.map((r) => r.netLives)).toEqual([5, 3, 1]);
  });

  it("a 3-way tie that's ALSO equal on net lives stays a genuine shared-rank tie", () => {
    // Same shape as above, but every winner banked the same lives -- the
    // group can't be separated, so all three share a rank. wins/draws/name
    // only pick a stable DISPLAY order, they never break the tie.
    const players = [
      P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"),
      P("dave", "Dave"), P("eve", "Eve"), P("frank", "Frank"),
    ];
    const pairings = [
      ML("alice", "dave", 2, 0, [G("alice", 2)]),
      ML("bob", "eve", 2, 0, [G("bob", 2)]),
      ML("carol", "frank", 2, 0, [G("carol", 2)]),
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
      ML("alice", "bob", 2, 0, [G("alice", 4), G("alice", 1)]), // h2h diff = +5 for alice
      ML("alice", "carol", 0, 2), // alice's compensating loss
      ML("carol", "eve", 1, 1),
      ML("bob", "dave", 2, 0), // bob's compensating win
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
    const pairings = [ML("alice", "bob", 1, 1, [G("alice", 5), G("bob", 2)])]; // h2h diff = +3 for alice
    const lives = computeStandings(players, pairings, [], undefined, "lives");
    expect(ids(lives)).toEqual(["alice", "bob"]);
    expect(lives.find((r) => r.player.id === "alice")!.h2hLives).toBe(3);
    expect(lives.find((r) => r.player.id === "bob")!.h2hLives).toBe(-3);
    expect(lives.find((r) => r.player.id === "bob")!.tiedWithPrev).toBeFalsy();
  });

  it("falls back to total net lives when the within-match differential is exactly zero", () => {
    const players = [P("alice", "Alice"), P("bob", "Bob"), P("carol", "Carol"), P("dave", "Dave")];
    const pairings = [
      ML("alice", "bob", 1, 1, [G("alice", 3), G("bob", 3)]), // h2h diff = 0
      ML("alice", "carol", 1, 1, [G("alice", 5)]), // alice's extra net lives
      ML("bob", "dave", 1, 1), // bob's compensating draw, no lives
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
      ML("alice", "carol", 2, 0, [G("alice", 1)]),
      ML("bob", "dave", 2, 0, [G("bob", 3)]),
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
      ML("alice", "carol", 2, 0, [G("alice", 4)]),
      ML("bob", "dave", 2, 0, [G("bob", 4)]),
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
