import { describe, expect, test } from "vitest";
import { rarityIndex, tierColors, tierSlug } from "./tier-colors";

describe("rarityIndex", () => {
  test.each([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
    [5, 0], // cycles back for a 5th custom tier
    [8, 3],
  ])("position %i -> index %i", (position, expected) => {
    expect(rarityIndex(position)).toBe(expected);
  });

  test("matches tierColors' own cycle length", () => {
    // Every position that maps to the same rarityIndex must also map to the
    // same tierColors() pair -- the two stay in lockstep by construction.
    for (let position = 1; position <= 8; position++) {
      const a = tierColors(position);
      const b = tierColors(position + 4); // one full palette cycle later
      if (rarityIndex(position) === rarityIndex(position + 4)) {
        expect(a).toEqual(b);
      }
    }
  });
});

describe("tierSlug", () => {
  test.each([
    ["Legendary", "legendary"],
    ["Common 2", "common-2"],
    ["Rare  A", "rare-a"],
    ["Uncommon/Tier!", "uncommon-tier"],
    ["--Weird--", "weird"],
  ])("%s -> %s", (name, expected) => {
    expect(tierSlug(name)).toBe(expected);
  });
});
