import { describe, it, expect } from "vitest";
import { normalizeScoringMode, selectStandingsEngine, buildScoringBadge } from "./standings-mode.js";

describe("normalizeScoringMode", () => {
  it.each([
    ["all", "all"],
    ["best-n-count", "best-n-count"],
    ["best-n-void", "best-n-void"],
    ["", "all"],
    ["bogus", "all"],
    ["ALL", "all"],
    [null, "all"],
    [undefined, "all"],
  ] as const)("normalizeScoringMode(%p) -> %p", (raw, expected) => {
    expect(normalizeScoringMode(raw)).toBe(expected);
  });
});

describe("selectStandingsEngine -- the live-standings-loader engine picker, DB-free", () => {
  it.each([
    ["all", { engine: "standard" }],
    ["best-n-count", { engine: "best-n", dropoutGames: "count" }],
    ["best-n-void", { engine: "best-n", dropoutGames: "void" }],
  ] as const)("selectStandingsEngine(%p) -> %p", (mode, expected) => {
    expect(selectStandingsEngine(mode)).toEqual(expected);
  });
});

describe("buildScoringBadge", () => {
  it("is null for mode 'all' regardless of dropouts", () => {
    expect(buildScoringBadge("all", 4, 6, 2)).toBeNull();
  });

  it("is null for a best-n mode with zero dropouts (engine already bypassed)", () => {
    expect(buildScoringBadge("best-n-count", 5, 6, 0)).toBeNull();
  });

  it.each([
    ["best-n-count"],
    ["best-n-void"],
  ] as const)("is the badge for a %s mode with at least one dropout", (mode) => {
    expect(buildScoringBadge(mode, 4, 6, 2)).toEqual({ mode, n: 4, k: 6, dropouts: 2 });
  });
});
