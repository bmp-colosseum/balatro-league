import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  titleStickers,
  netLivesForGames,
  initialsFor,
  flattenMatchesNewestFirst,
  type SeasonForStickers,
  type GameForNetLives,
  type SeasonForMatchHands,
} from "./profile-card-core.js";

const season = (
  tierName: string,
  tierPosition: number,
  rank: number,
): SeasonForStickers => ({ tierName, tierPosition, rank });

describe("titleStickers -- table-driven scenarios", () => {
  it("returns nothing for a player with no seasons", () => {
    expect(titleStickers([])).toEqual([]);
  });

  it("ignores seasons the player didn't win", () => {
    const seasons = [season("Common", 4, 2), season("Rare", 2, 0), season("Rare", 2, 3)];
    expect(titleStickers(seasons)).toEqual([]);
  });

  it("one division title -> one sticker with count 1", () => {
    const seasons = [season("Rare", 2, 1)];
    expect(titleStickers(seasons)).toEqual([{ tierName: "Rare", rarity: 1, count: 1 }]);
  });

  it("two titles in the same tier -> one sticker, count 2 (Rare x2)", () => {
    const seasons = [season("Rare", 2, 1), season("Rare", 2, 1), season("Rare", 2, 4)];
    expect(titleStickers(seasons)).toEqual([{ tierName: "Rare", rarity: 1, count: 2 }]);
  });

  it("titles across tiers sort in tier-ladder order (best position first)", () => {
    const seasons = [season("Common", 4, 1), season("Legendary", 1, 1), season("Uncommon", 3, 1)];
    expect(titleStickers(seasons)).toEqual([
      { tierName: "Legendary", rarity: 0, count: 1 },
      { tierName: "Uncommon", rarity: 2, count: 1 },
      { tierName: "Common", rarity: 3, count: 1 },
    ]);
  });

  it("a cold-cache rank of 0 never counts as a title", () => {
    expect(titleStickers([season("Rare", 2, 0)])).toEqual([]);
  });
});

// tierName <-> tierPosition is a fixed 1:1 pairing per tier in real data (a
// Tier row has exactly one name and one position); generating them
// independently would let the arbitrary invent two different tier names
// sharing one position, a combination the real domain never produces.
const TIER_PAIRS = [
  { tierName: "Legendary", tierPosition: 1 },
  { tierName: "Rare", tierPosition: 2 },
  { tierName: "Uncommon", tierPosition: 3 },
  { tierName: "Common", tierPosition: 4 },
] as const;
const arbSeason = fc
  .tuple(fc.constantFrom(...TIER_PAIRS), fc.integer({ min: 0, max: 5 }))
  .map(([tier, rank]) => ({ ...tier, rank }));

describe("titleStickers -- properties", () => {
  it("conservation: total sticker count equals the number of rank-1 seasons", () => {
    fc.assert(
      fc.property(fc.array(arbSeason), (seasons) => {
        const stickers = titleStickers(seasons);
        const totalStickers = stickers.reduce((sum, s) => sum + s.count, 0);
        const totalWins = seasons.filter((s) => s.rank === 1).length;
        expect(totalStickers).toBe(totalWins);
      }),
    );
  });

  it("order-independence: shuffled input produces the same grouped result", () => {
    fc.assert(
      fc.property(fc.array(arbSeason), (seasons) => {
        const reversed = [...seasons].reverse();
        expect(titleStickers(reversed)).toEqual(titleStickers(seasons));
      }),
    );
  });
});

const game = (iWon: boolean | null, lives: number | null): GameForNetLives => ({ iWon, lives });

describe("netLivesForGames -- table-driven scenarios", () => {
  it("is 0 for an empty list", () => {
    expect(netLivesForGames([])).toBe(0);
  });

  it("adds the winner's lives for a won game", () => {
    expect(netLivesForGames([game(true, 3)])).toBe(3);
  });

  it("subtracts the opponent's lives for a lost game", () => {
    expect(netLivesForGames([game(false, 2)])).toBe(-2);
  });

  it("ignores games with no recorded lives", () => {
    expect(netLivesForGames([game(true, null)])).toBe(0);
  });

  it("ignores games with an indeterminate winner", () => {
    expect(netLivesForGames([game(null, 4)])).toBe(0);
  });

  it("sums across a mixed set of games", () => {
    const games = [game(true, 3), game(false, 1), game(true, 2), game(null, 5), game(false, 4)];
    // +3 -1 +2 (null skipped) -4 = 0
    expect(netLivesForGames(games)).toBe(0);
  });
});

describe("initialsFor -- table-driven scenarios", () => {
  it("takes first+last initials for a multi-word name", () => {
    expect(initialsFor("Jane Doe")).toBe("JD");
  });

  it("takes first+last initials for a longer name, skipping the middle", () => {
    expect(initialsFor("Jane Q Doe")).toBe("JD");
  });

  it("takes one initial for a single-word name", () => {
    expect(initialsFor("solo")).toBe("S");
  });

  it("returns a placeholder for an empty name", () => {
    expect(initialsFor("")).toBe("?");
  });

  it("returns a placeholder for a whitespace-only name", () => {
    expect(initialsFor("   ")).toBe("?");
  });
});

interface FakeMatch {
  id: string;
  confirmedAt: Date | null;
}

const seasonForHands = (
  seasonName: string,
  divisionName: string,
  isActive: boolean,
  matches: FakeMatch[],
): SeasonForMatchHands<FakeMatch> => ({ seasonName, divisionName, isActive, matches });

describe("flattenMatchesNewestFirst -- table-driven scenarios", () => {
  it("returns nothing for no seasons", () => {
    expect(flattenMatchesNewestFirst([])).toEqual([]);
  });

  it("flattens matches from a single season, newest first", () => {
    const seasons = [
      seasonForHands("Season 1", "Div A", false, [
        { id: "m1", confirmedAt: new Date("2026-01-01") },
        { id: "m2", confirmedAt: new Date("2026-03-01") },
      ]),
    ];
    const result = flattenMatchesNewestFirst(seasons);
    expect(result.map((h) => h.match.id)).toEqual(["m2", "m1"]);
    expect(result[0]!.context).toEqual({ seasonName: "Season 1", divisionName: "Div A", isActiveSeason: false });
  });

  it("merges matches across seasons into one newest-first list", () => {
    const seasons = [
      seasonForHands("Season 1", "Div A", false, [{ id: "old", confirmedAt: new Date("2025-01-01") }]),
      seasonForHands("Season 2", "Div B", true, [{ id: "new", confirmedAt: new Date("2026-06-01") }]),
    ];
    const result = flattenMatchesNewestFirst(seasons);
    expect(result.map((h) => h.match.id)).toEqual(["new", "old"]);
  });

  it("sorts a null confirmedAt to the end", () => {
    const seasons = [
      seasonForHands("Season 1", "Div A", false, [
        { id: "undated", confirmedAt: null },
        { id: "dated", confirmedAt: new Date("2026-01-01") },
      ]),
    ];
    const result = flattenMatchesNewestFirst(seasons);
    expect(result.map((h) => h.match.id)).toEqual(["dated", "undated"]);
  });
});
