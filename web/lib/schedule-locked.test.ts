import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isScheduleLocked, isUnplayedPending, type UnplayableMatch } from "./schedule-locked.js";

const matchArb: fc.Arbitrary<UnplayableMatch> = fc.record({
  status: fc.constantFrom("PENDING", "CONFIRMED", "DISPUTED", "CANCELLED"),
  gamesWonA: fc.nat({ max: 2 }),
  gamesWonB: fc.nat({ max: 2 }),
});

describe("isUnplayedPending", () => {
  it("is true exactly for a 0-0 PENDING row", () => {
    expect(isUnplayedPending({ status: "PENDING", gamesWonA: 0, gamesWonB: 0 })).toBe(true);
    expect(isUnplayedPending({ status: "PENDING", gamesWonA: 1, gamesWonB: 0 })).toBe(false);
    expect(isUnplayedPending({ status: "CONFIRMED", gamesWonA: 0, gamesWonB: 0 })).toBe(false);
  });
});

describe("isScheduleLocked", () => {
  it("the flag alone is a sufficient (not just necessary) condition", () => {
    fc.assert(
      fc.property(fc.array(matchArb, { maxLength: 10 }), (matches) => {
        expect(isScheduleLocked(true, matches)).toBe(true);
      }),
    );
  });

  it("with the flag false, matches any unplayed-pending row among the matches", () => {
    fc.assert(
      fc.property(fc.array(matchArb, { minLength: 1, maxLength: 20 }), (matches) => {
        const expected = matches.some(isUnplayedPending);
        expect(isScheduleLocked(false, matches)).toBe(expected);
      }),
    );
  });

  it("false flag + no unplayed-pending rows (incl. empty) is unlocked", () => {
    expect(isScheduleLocked(false, [])).toBe(false);
    expect(isScheduleLocked(false, [{ status: "CONFIRMED", gamesWonA: 2, gamesWonB: 0 }])).toBe(false);
  });
});
