import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeEarnedTraits, topStakeDeterministic, TRAIT_GAMES_FLOOR, type TraitGameRow } from "./trait-rules.js";

describe("topStakeDeterministic", () => {
  it("picks the highest metric count, alphabetical name as the final tiebreak", () => {
    expect(topStakeDeterministic({ Gold: 3, White: 3 }, { Gold: 1, White: 1 })).toBe("Gold");
    expect(topStakeDeterministic({ Gold: 5, White: 2 }, {})).toBe("Gold");
  });

  it("returns null when every count is zero or absent", () => {
    expect(topStakeDeterministic({}, {})).toBeNull();
    expect(topStakeDeterministic({ Gold: 0 }, {})).toBeNull();
  });

  it("is deterministic across key insertion order (sorts by name first)", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom("Gold", "White", "Red", "Blue"), fc.nat({ max: 20 })), (metric) => {
        const a = topStakeDeterministic(metric, {});
        const shuffledEntries = Object.fromEntries(Object.entries(metric).reverse());
        const b = topStakeDeterministic(shuffledEntries, {});
        expect(a).toBe(b);
      }),
    );
  });
});

function gameRow(overrides: Partial<TraitGameRow> = {}): TraitGameRow {
  return {
    firstPlayerId: "opponent",
    winnerId: "me",
    pickedRandomly: false,
    pool: [{ deck: "Red", stake: "White", picked: true, bannedById: null }],
    ...overrides,
  };
}

describe("computeEarnedTraits", () => {
  it("below the games floor, earns nothing no matter how extreme the stats", () => {
    const games = Array.from({ length: TRAIT_GAMES_FLOOR - 1 }, () =>
      gameRow({ pool: [{ deck: "Red", stake: "White", picked: true, bannedById: null }] }),
    );
    expect(computeEarnedTraits("me", games)).toEqual([]);
  });

  it("white-warrior: White both most-played and most-won, at/above the floor", () => {
    const games = Array.from({ length: TRAIT_GAMES_FLOOR }, () =>
      gameRow({ winnerId: "me", pool: [{ deck: "Red", stake: "White", picked: true, bannedById: null }] }),
    );
    const earned = computeEarnedTraits("me", games);
    expect(earned.map((t) => t.key)).toContain("white-warrior");
  });

  it("games with an empty pool don't count toward the floor or any trait", () => {
    const real = Array.from({ length: TRAIT_GAMES_FLOOR }, () =>
      gameRow({ pool: [{ deck: "Red", stake: "White", picked: true, bannedById: null }] }),
    );
    const padding = Array.from({ length: 50 }, () => gameRow({ pool: [] }));
    expect(computeEarnedTraits("me", [...real, ...padding])).toEqual(
      computeEarnedTraits("me", real),
    );
  });

  it("ghostbuster requires Ghost to be available AND banned >= 60% of the time", () => {
    const base = Array.from({ length: TRAIT_GAMES_FLOOR }, () =>
      gameRow({ pool: [{ deck: "Blue", stake: "Gold", picked: true, bannedById: null }] }),
    );
    const withGhostBanned = (n: number, total: number) =>
      Array.from({ length: total }, (_, i) =>
        gameRow({
          pool: [
            { deck: "Ghost", stake: "White", picked: false, bannedById: i < n ? "me" : null },
            { deck: "Blue", stake: "Gold", picked: true, bannedById: null },
          ],
        }),
      );
    const earnedAt60 = computeEarnedTraits("me", [...base, ...withGhostBanned(6, 10)]);
    expect(earnedAt60.map((t) => t.key)).toContain("ghostbuster");
    const earnedBelow60 = computeEarnedTraits("me", [...base, ...withGhostBanned(5, 10)]);
    expect(earnedBelow60.map((t) => t.key)).not.toContain("ghostbuster");
  });

  it("is a pure function: same input games (even freshly re-built) give the same output", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            firstPlayerId: fc.constantFrom("me", "opponent"),
            winnerId: fc.constantFrom<string | null>("me", "opponent", null),
            pickedRandomly: fc.boolean(),
            pool: fc.array(
              fc.record({
                deck: fc.constantFrom("Red", "Blue", "Ghost"),
                stake: fc.constantFrom("White", "Gold"),
                picked: fc.boolean(),
                bannedById: fc.constantFrom<string | null>("me", "opponent", null),
              }),
              { maxLength: 4 },
            ),
          }),
          { maxLength: 25 },
        ),
        (games) => {
          const a = computeEarnedTraits("me", games);
          const b = computeEarnedTraits("me", JSON.parse(JSON.stringify(games)));
          expect(a).toEqual(b);
        },
      ),
    );
  });
});
