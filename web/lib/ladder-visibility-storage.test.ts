import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  LADDER_HIDDEN_STORAGE_KEY,
  formatStoredLadderHidden,
  parseStoredLadderHidden,
} from "./ladder-visibility-storage.js";

describe("LADDER_HIDDEN_STORAGE_KEY", () => {
  it("is a single fixed key (one ladder strip site-wide, no per-id namespacing)", () => {
    expect(LADDER_HIDDEN_STORAGE_KEY).toBe("ladder-hidden");
  });
});

describe("parseStoredLadderHidden / formatStoredLadderHidden", () => {
  it("round-trips both booleans", () => {
    expect(parseStoredLadderHidden(formatStoredLadderHidden(true))).toBe(true);
    expect(parseStoredLadderHidden(formatStoredLadderHidden(false))).toBe(false);
  });

  it("treats null (nothing stored) and any unrecognized value as unknown", () => {
    expect(parseStoredLadderHidden(null)).toBeNull();
    expect(parseStoredLadderHidden("")).toBeNull();
    expect(parseStoredLadderHidden("true")).toBeNull();
    expect(parseStoredLadderHidden("garbage")).toBeNull();
  });

  it("round-trip property: formatting then parsing never loses the boolean", () => {
    fc.assert(
      fc.property(fc.boolean(), (hidden) => {
        expect(parseStoredLadderHidden(formatStoredLadderHidden(hidden))).toBe(hidden);
      }),
    );
  });
});
