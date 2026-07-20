import { describe, it, expect } from "vitest";
import { seasonEndsHammer, seasonEndsHeader } from "./season-timing.js";

describe("season-timing", () => {
  const d = new Date("2026-08-01T00:00:00.000Z");
  const unix = Math.floor(d.getTime() / 1000);

  it("returns null / empty when no end date is set", () => {
    expect(seasonEndsHammer(null)).toBeNull();
    expect(seasonEndsHammer(undefined)).toBeNull();
    expect(seasonEndsHeader(null)).toBe("");
    expect(seasonEndsHeader(undefined)).toBe("");
  });

  it("builds full + relative hammertime tags from the unix seconds", () => {
    expect(seasonEndsHammer(d)).toEqual({ full: `<t:${unix}:F>`, relative: `<t:${unix}:R>` });
  });

  it("header is an h2 line embedding both tags", () => {
    const h = seasonEndsHeader(d);
    expect(h.startsWith("## ")).toBe(true);
    expect(h).toContain(`<t:${unix}:F>`);
    expect(h).toContain(`<t:${unix}:R>`);
  });
});
