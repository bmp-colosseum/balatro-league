import { describe, it, expect } from "vitest";
import {
  planShootoutCleanup,
  type ShootoutCleanupInput,
  type PlayerNetLives,
} from "./shootout-cleanup-core.js";

const shootout = (
  id: string,
  playerAId: string,
  playerBId: string,
  winnerId: string | null,
  recordedBy: string | null = "admin-1",
): ShootoutCleanupInput => ({ id, divisionId: "d1", playerAId, playerBId, winnerId, recordedBy });

const lives = (netLives: number, livesGamesMissing = 0): PlayerNetLives => ({ netLives, livesGamesMissing });

describe("planShootoutCleanup -- one case per verdict", () => {
  it("'same': winner has the higher net lives -- deletable", () => {
    const shootouts = [shootout("s1", "pA", "pB", "pA")];
    const netLives = new Map([
      ["pA", lives(5)],
      ["pB", lives(2)],
    ]);
    const plan = planShootoutCleanup(shootouts, netLives);
    expect(plan.deletable).toEqual([
      { id: "s1", divisionId: "d1", playerAId: "pA", playerBId: "pB", winnerId: "pA", livesA: 5, livesB: 2, verdict: "same" },
    ]);
    expect(plan.keep).toEqual([]);
  });

  it("'lives-disagree': winner has LOWER net lives -- keep", () => {
    const shootouts = [shootout("s1", "pA", "pB", "pA")];
    const netLives = new Map([
      ["pA", lives(1)],
      ["pB", lives(4)],
    ]);
    const plan = planShootoutCleanup(shootouts, netLives);
    expect(plan.keep).toEqual([
      { id: "s1", divisionId: "d1", playerAId: "pA", playerBId: "pB", winnerId: "pA", livesA: 1, livesB: 4, verdict: "lives-disagree" },
    ]);
    expect(plan.deletable).toEqual([]);
  });

  it("'lives-tied': equal net lives -- keep", () => {
    const shootouts = [shootout("s1", "pA", "pB", "pA")];
    const netLives = new Map([
      ["pA", lives(3)],
      ["pB", lives(3)],
    ]);
    const plan = planShootoutCleanup(shootouts, netLives);
    expect(plan.keep).toEqual([
      { id: "s1", divisionId: "d1", playerAId: "pA", playerBId: "pB", winnerId: "pA", livesA: 3, livesB: 3, verdict: "lives-tied" },
    ]);
    expect(plan.deletable).toEqual([]);
  });

  it("'no-lives-data': no winnerId recorded -- keep", () => {
    const shootouts = [shootout("s1", "pA", "pB", null)];
    const netLives = new Map([
      ["pA", lives(3)],
      ["pB", lives(1)],
    ]);
    const plan = planShootoutCleanup(shootouts, netLives);
    expect(plan.keep).toEqual([
      { id: "s1", divisionId: "d1", playerAId: "pA", playerBId: "pB", winnerId: null, livesA: 3, livesB: 1, verdict: "no-lives-data" },
    ]);
  });

  it("'no-lives-data': a player missing from netLivesByPlayerId -- keep", () => {
    const shootouts = [shootout("s1", "pA", "pB", "pA")];
    const netLives = new Map([["pA", lives(3)]]); // pB not present at all
    const plan = planShootoutCleanup(shootouts, netLives);
    expect(plan.keep).toEqual([
      { id: "s1", divisionId: "d1", playerAId: "pA", playerBId: "pB", winnerId: "pA", livesA: 3, livesB: null, verdict: "no-lives-data" },
    ]);
  });

  it("'no-lives-data': a player has a counted game missing winnerLives -- keep", () => {
    const shootouts = [shootout("s1", "pA", "pB", "pA")];
    const netLives = new Map([
      ["pA", lives(5)],
      ["pB", lives(2, 1)], // one counted game missing recorded lives
    ]);
    const plan = planShootoutCleanup(shootouts, netLives);
    expect(plan.keep).toEqual([
      { id: "s1", divisionId: "d1", playerAId: "pA", playerBId: "pB", winnerId: "pA", livesA: 5, livesB: 2, verdict: "no-lives-data" },
    ]);
  });

  it("'player-reported': recordedBy null -- always keep, even if lives agrees", () => {
    const shootouts = [shootout("s1", "pA", "pB", "pA", null)];
    const netLives = new Map([
      ["pA", lives(9)],
      ["pB", lives(1)],
    ]);
    const plan = planShootoutCleanup(shootouts, netLives);
    expect(plan.keep).toEqual([
      { id: "s1", divisionId: "d1", playerAId: "pA", playerBId: "pB", winnerId: "pA", livesA: 9, livesB: 1, verdict: "player-reported" },
    ]);
    expect(plan.deletable).toEqual([]);
  });
});

describe("planShootoutCleanup -- mixed batch", () => {
  it("splits a mixed batch, preserving input order within each output array", () => {
    const shootouts = [
      shootout("same-1", "pA", "pB", "pA"),
      shootout("reported-1", "pC", "pD", "pC", null),
      shootout("disagree-1", "pE", "pF", "pE"),
      shootout("same-2", "pG", "pH", "pH"),
      shootout("tied-1", "pI", "pJ", "pI"),
      shootout("no-data-1", "pK", "pL", null),
    ];
    const netLives = new Map([
      ["pA", lives(5)], ["pB", lives(1)],
      ["pC", lives(5)], ["pD", lives(1)],
      ["pE", lives(1)], ["pF", lives(5)],
      ["pG", lives(1)], ["pH", lives(5)],
      ["pI", lives(2)], ["pJ", lives(2)],
      ["pK", lives(2)], ["pL", lives(2)],
    ]);

    const plan = planShootoutCleanup(shootouts, netLives);

    expect(plan.deletable.map((e) => e.id)).toEqual(["same-1", "same-2"]);
    expect(plan.keep.map((e) => e.id)).toEqual(["reported-1", "disagree-1", "tied-1", "no-data-1"]);
    expect(plan.keep.map((e) => e.verdict)).toEqual([
      "player-reported",
      "lives-disagree",
      "lives-tied",
      "no-lives-data",
    ]);
  });
});
