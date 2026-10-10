import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { findNewcomerPlayerIds, type SeasonMembership } from "./newcomers-core.js";

function m(playerId: string, seasonNumber: number): SeasonMembership {
  return { playerId, seasonNumber };
}

describe("findNewcomerPlayerIds", () => {
  it.each<{ name: string; memberships: SeasonMembership[]; target: number; expected: string[] }>([
    { name: "no memberships", memberships: [], target: 1, expected: [] },
    {
      name: "both players' first season is the target",
      memberships: [m("a", 1), m("b", 1)],
      target: 1,
      expected: ["a", "b"],
    },
    {
      name: "a returning player (first season 1) isn't a newcomer in season 2",
      memberships: [m("a", 1), m("a", 2), m("b", 2)],
      target: 2,
      expected: ["b"],
    },
    {
      name: "target season with zero newcomers",
      memberships: [m("a", 1), m("b", 1)],
      target: 2,
      expected: [],
    },
    {
      name: "duplicate rows for the same player/season are still counted once",
      memberships: [m("a", 1), m("a", 1), m("a", 1)],
      target: 1,
      expected: ["a"],
    },
    {
      name: "a player's EARLIEST season wins even if rows arrive out of order",
      memberships: [m("a", 3), m("a", 1), m("a", 2)],
      target: 1,
      expected: ["a"],
    },
    {
      name: "result is sorted regardless of input order",
      memberships: [m("c", 1), m("a", 1), m("b", 1)],
      target: 1,
      expected: ["a", "b", "c"],
    },
  ])("$name", ({ memberships, target, expected }) => {
    expect(findNewcomerPlayerIds(memberships, target)).toEqual(expected);
  });

  // Reference (brute-force) implementation for the property tests below: group
  // by playerId, take the min seasonNumber, filter + sort. Deliberately
  // written differently (Object grouping instead of a single Map pass) so it
  // isn't just the same code restated.
  function reference(memberships: SeasonMembership[], target: number): string[] {
    const byPlayer: Record<string, number[]> = {};
    for (const m of memberships) {
      (byPlayer[m.playerId] ??= []).push(m.seasonNumber);
    }
    return Object.entries(byPlayer)
      .filter(([, seasons]) => Math.min(...seasons) === target)
      .map(([playerId]) => playerId)
      .sort();
  }

  const membershipArb = fc.array(
    fc.record({
      playerId: fc.constantFrom("p1", "p2", "p3", "p4", "p5"),
      seasonNumber: fc.integer({ min: 1, max: 6 }),
    }),
    { maxLength: 40 },
  );

  it("agrees with a brute-force reference implementation", () => {
    fc.assert(
      fc.property(membershipArb, fc.integer({ min: 1, max: 6 }), (memberships, target) => {
        expect(findNewcomerPlayerIds(memberships, target)).toEqual(reference(memberships, target));
      }),
    );
  });

  it("is order-independent: shuffling the membership rows doesn't change the result", () => {
    fc.assert(
      fc.property(membershipArb, fc.integer({ min: 1, max: 6 }), fc.integer(), (memberships, target, seed) => {
        // Deterministic shuffle derived from `seed` (fast-check reruns this
        // property many times; Math.random() would make failures unreproducible).
        const shuffled = [...memberships]
          .map((v, i) => ({ v, k: Math.sin(seed + i) }))
          .sort((a, b) => a.k - b.k)
          .map((x) => x.v);
        expect(findNewcomerPlayerIds(shuffled, target)).toEqual(findNewcomerPlayerIds(memberships, target));
      }),
    );
  });

  it("never returns duplicate player ids", () => {
    fc.assert(
      fc.property(membershipArb, fc.integer({ min: 1, max: 6 }), (memberships, target) => {
        const result = findNewcomerPlayerIds(memberships, target);
        expect(new Set(result).size).toBe(result.length);
      }),
    );
  });
});
