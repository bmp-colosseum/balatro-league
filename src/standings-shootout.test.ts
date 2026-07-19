import { describe, it, expect } from "vitest";
import type { Match, Player } from "@prisma/client";
import { computeStandings, shootoutsNeeded } from "./standings.js";

const P = (id: string, displayName: string): Player => ({ id, displayName }) as unknown as Player;
type PairingInput = Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">;
const M = (a: string, b: string, ga: number, gb: number): PairingInput => ({
  playerAId: a,
  playerBId: b,
  gamesWonA: ga,
  gamesWonB: gb,
});

// Sugar: compute ranked standings then run detection.
const detect = (players: Player[], pairings: PairingInput[], promote: number, relegate: number) =>
  shootoutsNeeded(computeStandings(players, pairings), promote, relegate);

const players4 = [P("p1", "Ada"), P("p2", "Ben"), P("p3", "Cy"), P("p4", "Dot")];

// p1 sweeps everyone; p2 & p3 split 1-1 and both beat p4 -> tied on the whole
// chain (4pts, 1 win, 1 draw each); p4 loses out. Ranks: p1=1, p2=2, p3=2, p4=4.
const twoWayTie: PairingInput[] = [
  M("p1", "p2", 2, 0),
  M("p1", "p3", 2, 0),
  M("p1", "p4", 2, 0),
  M("p2", "p3", 1, 1),
  M("p2", "p4", 2, 0),
  M("p3", "p4", 2, 0),
];

describe("shootoutsNeeded", () => {
  it("flags a 2-player tie straddling the promotion cutoff", () => {
    const needs = detect(players4, twoWayTie, 2, 1); // top 2 promote, bottom 1 relegates
    expect(needs).toHaveLength(1);
    expect(needs[0]!.boundary).toBe("promotion");
    expect([needs[0]!.aId, needs[0]!.bId].sort()).toEqual(["p2", "p3"]);
  });

  it("stays silent when the tie sits entirely inside the promotion zone", () => {
    // Only 1 promotes: the p2/p3 tie is for 2nd, wholly below the cutoff -> no shootout.
    expect(detect(players4, twoWayTie, 1, 1)).toEqual([]);
  });

  it("stays silent when the tie is entirely outside both boundaries", () => {
    // Nobody promotes or relegates: a mid-table tie decides nothing.
    expect(detect(players4, twoWayTie, 0, 0)).toEqual([]);
  });

  it("flags a 2-player tie straddling the relegation cutoff", () => {
    // p3 & p4 tie for the last safe spot; p1 & p2 clear above. relegate 1 of 4.
    const pairings: PairingInput[] = [
      M("p1", "p2", 1, 1),
      M("p1", "p3", 2, 0),
      M("p1", "p4", 2, 0),
      M("p2", "p3", 2, 0),
      M("p2", "p4", 2, 0),
      M("p3", "p4", 1, 1),
    ];
    // p1=1(draw)+3+3=7, p2=1+3+3=7 (tie top, but promote 0 so ignored),
    // p3=0+0+1=1, p4=0+0+1=1 -> p3/p4 tied for last, straddle relegation cutoff (pos 3).
    const needs = shootoutsNeeded(computeStandings(players4, pairings), 0, 1);
    expect(needs).toHaveLength(1);
    expect(needs[0]!.boundary).toBe("relegation");
    expect([needs[0]!.aId, needs[0]!.bId].sort()).toEqual(["p3", "p4"]);
  });

  it("does NOT flag a 3-way tie (net lives settles those)", () => {
    // p2, p3, p4 all mutually 1-1 and each lose to p1 -> three-way tie at 2pts.
    const threeWay: PairingInput[] = [
      M("p1", "p2", 2, 0),
      M("p1", "p3", 2, 0),
      M("p1", "p4", 2, 0),
      M("p2", "p3", 1, 1),
      M("p2", "p4", 1, 1),
      M("p3", "p4", 1, 1),
    ];
    expect(detect(players4, threeWay, 2, 1)).toEqual([]);
  });

  it("does NOT flag when head-to-head already decided it (no tie exists)", () => {
    // Same as twoWayTie but p2 beats p3 2-0 -> p2 ranks above p3, not tied.
    const decisive = twoWayTie.map((m) => (m.playerAId === "p2" && m.playerBId === "p3" ? M("p2", "p3", 2, 0) : m));
    expect(detect(players4, decisive, 2, 1)).toEqual([]);
  });

  it("does NOT promote-shootout in the top division (promote 0)", () => {
    // A tie for 1st but nothing promotes above the top division.
    expect(detect(players4, twoWayTie, 0, 1).some((n) => n.boundary === "promotion")).toBe(false);
  });
});
