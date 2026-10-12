import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { divisionOpenStorageKey, formatStoredOpen, parseStoredOpen } from "./division-open-storage.js";

describe("divisionOpenStorageKey", () => {
  it("namespaces the key by division id", () => {
    expect(divisionOpenStorageKey("rare-1")).toBe("division-open:rare-1");
  });

  it("is injective: distinct ids never collide on the same key", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        expect(divisionOpenStorageKey(a)).not.toBe(divisionOpenStorageKey(b));
      }),
    );
  });
});

describe("parseStoredOpen / formatStoredOpen", () => {
  it("round-trips both booleans", () => {
    expect(parseStoredOpen(formatStoredOpen(true))).toBe(true);
    expect(parseStoredOpen(formatStoredOpen(false))).toBe(false);
  });

  it("treats null (nothing stored) and any unrecognized value as unknown", () => {
    expect(parseStoredOpen(null)).toBeNull();
    expect(parseStoredOpen("")).toBeNull();
    expect(parseStoredOpen("true")).toBeNull();
    expect(parseStoredOpen("garbage")).toBeNull();
  });

  it("round-trip property: formatting then parsing never loses the boolean", () => {
    fc.assert(
      fc.property(fc.boolean(), (open) => {
        expect(parseStoredOpen(formatStoredOpen(open))).toBe(open);
      }),
    );
  });
});
