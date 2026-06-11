import { describe, it, expect } from "vitest";
import type { Match, Player } from "@prisma/client";
import { computeStandings, type ShootoutInput } from "./standings.js";

// computeStandings only reads id + displayName off Player.
const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;

type PairingInput = Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">;
const M = (playerAId: string, playerBId: string, gamesWonA: number, gamesWonB: number): PairingInput => ({
  playerAId,
  playerBId,
  gamesWonA,
  gamesWonB,
});

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
