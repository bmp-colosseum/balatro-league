import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { safeSignInRedirect } from "./signin-redirect.js";

describe("safeSignInRedirect", () => {
  it("passes through a same-origin relative path", () => {
    expect(safeSignInRedirect("/report")).toBe("/report");
    expect(safeSignInRedirect("/players")).toBe("/players");
    expect(safeSignInRedirect("/divisions/abc123")).toBe("/divisions/abc123");
  });

  it("falls back to /me when from is missing or empty", () => {
    expect(safeSignInRedirect(undefined)).toBe("/me");
    expect(safeSignInRedirect(null)).toBe("/me");
    expect(safeSignInRedirect("")).toBe("/me");
  });

  it("honors a custom fallback", () => {
    expect(safeSignInRedirect(undefined, "/standings")).toBe("/standings");
  });

  it.each([
    "https://evil.com",
    "http://evil.com/phish",
    "//evil.com",
    "/\\evil.com",
    "evil.com",
    "me",
    " /me",
    "/me ",
    "/me\nhttp://evil.com",
  ])("rejects an unsafe target: %s", (from) => {
    expect(safeSignInRedirect(from)).toBe("/me");
  });

  it("never returns a value that doesn't start with exactly one leading slash (no open redirect)", () => {
    fc.assert(
      fc.property(fc.string(), (from) => {
        const result = safeSignInRedirect(from);
        expect(result === "/me" || (result.startsWith("/") && !result.startsWith("//"))).toBe(true);
      }),
    );
  });

  it("is idempotent -- re-validating its own output returns the same path", () => {
    fc.assert(
      fc.property(fc.webPath(), (from) => {
        const once = safeSignInRedirect(from);
        const twice = safeSignInRedirect(once);
        expect(twice).toBe(once);
      }),
    );
  });
});
