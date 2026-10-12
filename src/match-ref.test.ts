import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { matchRef } from "./match-ref.js";

describe("matchRef", () => {
  it("takes the last 6 characters, uppercased", () => {
    expect(matchRef("cmg3k7x2q000dp92q9rxg53qv")).toBe("XG53QV");
  });

  it("uppercases a mixed-case id", () => {
    expect(matchRef("abcDEF")).toBe("ABCDEF");
  });

  it("is always exactly 6 characters for any id of 6+ chars", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 6, maxLength: 40 }), (id) => {
        expect(matchRef(id)).toHaveLength(6);
      }),
    );
  });

  it("never contains lowercase letters", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (id) => {
        expect(matchRef(id)).toBe(matchRef(id).toUpperCase());
      }),
    );
  });
});
