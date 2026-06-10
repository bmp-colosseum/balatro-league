import { describe, it, expect } from "vitest";
import {
  POINTS_FOR_2_0_WIN,
  POINTS_FOR_1_1_DRAW,
  POINTS_FOR_LOSS,
  parsePairingResult,
  pointsFromGames,
  gamesFromResult,
} from "./scoring.js";

describe("scoring constants", () => {
  it("are the canonical 3 / 1 / 0", () => {
    expect(POINTS_FOR_2_0_WIN).toBe(3);
    expect(POINTS_FOR_1_1_DRAW).toBe(1);
    expect(POINTS_FOR_LOSS).toBe(0);
  });
});

describe("parsePairingResult", () => {
  it("accepts the three valid results", () => {
    expect(parsePairingResult("2-0")).toBe("2-0");
    expect(parsePairingResult("1-1")).toBe("1-1");
    expect(parsePairingResult("0-2")).toBe("0-2");
  });
  it("rejects anything else", () => {
    for (const bad of ["", "2-1", "3-0", "0-0", "win", "2:0", " 2-0"]) {
      expect(parsePairingResult(bad)).toBeNull();
    }
  });
});

describe("pointsFromGames", () => {
  it("awards 3 for a 2-0 win", () => {
    expect(pointsFromGames(2, 0)).toBe(POINTS_FOR_2_0_WIN);
  });
  it("awards 1 each for a 1-1 draw", () => {
    expect(pointsFromGames(1, 1)).toBe(POINTS_FOR_1_1_DRAW);
  });
  it("awards 0 for a 0-2 loss", () => {
    expect(pointsFromGames(0, 2)).toBe(POINTS_FOR_LOSS);
  });
  it("awards 0 for malformed scores (caller validates upstream)", () => {
    expect(pointsFromGames(2, 1)).toBe(0);
    expect(pointsFromGames(3, 0)).toBe(0);
    expect(pointsFromGames(0, 0)).toBe(0);
  });
});

describe("gamesFromResult", () => {
  it("maps each result to game counts", () => {
    expect(gamesFromResult("2-0")).toEqual({ a: 2, b: 0 });
    expect(gamesFromResult("1-1")).toEqual({ a: 1, b: 1 });
    expect(gamesFromResult("0-2")).toEqual({ a: 0, b: 2 });
  });

  it("round-trips through pointsFromGames consistently", () => {
    // A 2-0 for A is a 0-2 for B; points should mirror.
    const { a, b } = gamesFromResult("2-0");
    expect(pointsFromGames(a, b)).toBe(3);
    expect(pointsFromGames(b, a)).toBe(0);
  });
});
