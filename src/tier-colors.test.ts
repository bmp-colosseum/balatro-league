import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { FALLBACK_ACCENT_COLOR, rarityIndex, tierAccentColor } from "./tier-colors.js";

describe("rarityIndex", () => {
  it("maps position 1-4 to indices 0-3", () => {
    expect(rarityIndex(1)).toBe(0);
    expect(rarityIndex(2)).toBe(1);
    expect(rarityIndex(3)).toBe(2);
    expect(rarityIndex(4)).toBe(3);
  });

  it("cycles back to 0 past the fourth tier", () => {
    expect(rarityIndex(5)).toBe(0);
    expect(rarityIndex(8)).toBe(3);
  });
});

describe("tierAccentColor", () => {
  it("returns the legendary color for position 1", () => {
    expect(tierAccentColor(1)).toBe(0xbb73d6);
  });

  it("returns the rare color for position 2", () => {
    expect(tierAccentColor(2)).toBe(0xff6259);
  });

  it("returns the uncommon color for position 3", () => {
    expect(tierAccentColor(3)).toBe(0x3cc78f);
  });

  it("returns the common color for position 4", () => {
    expect(tierAccentColor(4)).toBe(0x1e9bff);
  });

  it("cycles back to legendary for position 5", () => {
    expect(tierAccentColor(5)).toBe(0xbb73d6);
  });

  it("falls back to gold for null/undefined/zero/negative/non-finite positions", () => {
    expect(tierAccentColor(null)).toBe(FALLBACK_ACCENT_COLOR);
    expect(tierAccentColor(undefined)).toBe(FALLBACK_ACCENT_COLOR);
    expect(tierAccentColor(0)).toBe(FALLBACK_ACCENT_COLOR);
    expect(tierAccentColor(-1)).toBe(FALLBACK_ACCENT_COLOR);
    expect(tierAccentColor(Number.NaN)).toBe(FALLBACK_ACCENT_COLOR);
  });

  it("is always one of the five known colors for any finite position >= 1", () => {
    const known = new Set([0xbb73d6, 0xff6259, 0x3cc78f, 0x1e9bff, FALLBACK_ACCENT_COLOR]);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (position) => {
        expect(known.has(tierAccentColor(position))).toBe(true);
      }),
    );
  });
});
