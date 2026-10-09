import { describe, it, expect } from "vitest";
import { discordAvatarUrl, initials } from "./avatar.js";

describe("discordAvatarUrl", () => {
  it("builds a .png URL for a normal avatar hash", () => {
    expect(discordAvatarUrl("123", "abc123")).toBe(
      "https://cdn.discordapp.com/avatars/123/abc123.png?size=64",
    );
  });

  it("builds a .gif URL when the hash is animated (a_ prefix)", () => {
    expect(discordAvatarUrl("123", "a_abc123")).toBe(
      "https://cdn.discordapp.com/avatars/123/a_abc123.gif?size=64",
    );
  });

  it("respects a custom size", () => {
    expect(discordAvatarUrl("123", "abc123", 256)).toBe(
      "https://cdn.discordapp.com/avatars/123/abc123.png?size=256",
    );
  });

  it.each([null, undefined, ""])("returns null when the hash is %p", (hash) => {
    expect(discordAvatarUrl("123", hash)).toBeNull();
  });
});

describe("initials", () => {
  it("returns the first two letters, upper-cased, for a single word", () => {
    expect(initials("coolguy")).toBe("CO");
  });

  it("returns the first letter of the first two words, upper-cased", () => {
    expect(initials("Jane Doe")).toBe("JD");
  });

  it("ignores extra words past the first two", () => {
    expect(initials("Jane Middle Doe")).toBe("JM");
  });

  it("collapses repeated whitespace", () => {
    expect(initials("  Jane   Doe  ")).toBe("JD");
  });

  it("returns empty string for empty/whitespace-only input", () => {
    expect(initials("")).toBe("");
    expect(initials("   ")).toBe("");
  });
});
