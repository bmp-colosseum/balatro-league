import { describe, it, expect } from "vitest";
import { seasonEndsHammer, seasonEndsHeader, seasonTimelineLines, parseBufferDays } from "./season-timing.js";

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

describe("seasonTimelineLines", () => {
  const d = new Date("2026-08-01T00:00:00.000Z");
  const unix = Math.floor(d.getTime() / 1000);

  it("is empty when no end date is set", () => {
    expect(seasonTimelineLines(null)).toEqual([]);
    expect(seasonTimelineLines(undefined, 3)).toEqual([]);
  });

  it("renders the deadline, the buffer, and a DERIVED next-season date", () => {
    const lines = seasonTimelineLines(d, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`<t:${unix}:F>`);
    expect(lines[1]).toContain("**2 days**");
    expect(lines[1]).toContain(`<t:${unix + 2 * 86400}:D>`); // end + buffer
  });

  it("singularizes a one-day buffer", () => {
    expect(seasonTimelineLines(d, 1)[1]).toContain("**1 day**");
  });

  it("falls back to the default buffer on a nonsense value", () => {
    expect(seasonTimelineLines(d, Number.NaN)[1]).toContain("**2 days**");
  });
});

describe("parseBufferDays", () => {
  it("defaults to 2 for unset/garbage", () => {
    expect(parseBufferDays(null)).toBe(2);
    expect(parseBufferDays(undefined)).toBe(2);
    expect(parseBufferDays("abc")).toBe(2);
    expect(parseBufferDays("-1")).toBe(2);
  });

  it("parses a configured value", () => {
    expect(parseBufferDays("3")).toBe(3);
    expect(parseBufferDays("0")).toBe(0);
  });
});
