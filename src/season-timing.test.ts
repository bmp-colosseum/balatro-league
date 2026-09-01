import { describe, it, expect } from "vitest";
import {
  seasonEndsHammer,
  seasonEndsHeader,
  seasonStartsHammer,
  seasonTimelineLines,
  seasonWindowLines,
  parseBufferDays,
} from "./season-timing.js";

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

  it("promises no settling window when the buffer is 0", () => {
    const lines = seasonTimelineLines(d, 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain("0 days");
    expect(lines[1]).toContain("right after");
    // The deadline itself still shows.
    expect(lines[0]).toContain(`<t:${unix}:F>`);
  });

  it("falls back to the default buffer on a nonsense value", () => {
    expect(seasonTimelineLines(d, Number.NaN)[1]).toContain("**2 days**");
  });
});

describe("seasonStartsHammer", () => {
  const d = new Date("2026-08-01T00:00:00.000Z");
  const unix = Math.floor(d.getTime() / 1000);

  it("returns null when no start date is set", () => {
    expect(seasonStartsHammer(null)).toBeNull();
    expect(seasonStartsHammer(undefined)).toBeNull();
  });

  it("builds full + relative hammertime tags from the unix seconds", () => {
    expect(seasonStartsHammer(d)).toEqual({ full: `<t:${unix}:F>`, relative: `<t:${unix}:R>` });
  });
});

describe("seasonWindowLines", () => {
  const scheduledStart = new Date("2026-09-01T00:00:00.000Z");
  const scheduledStartUnix = Math.floor(scheduledStart.getTime() / 1000);
  const started = new Date("2026-08-01T00:00:00.000Z");
  const startedUnix = Math.floor(started.getTime() / 1000);
  const scheduledEnd = new Date("2026-08-15T00:00:00.000Z");
  const scheduledEndUnix = Math.floor(scheduledEnd.getTime() / 1000);

  it("not started + scheduledStartAt set -> a prominent starts line with the right unix", () => {
    const lines = seasonWindowLines({ isActive: false, scheduledStartAt: scheduledStart });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`<t:${scheduledStartUnix}:F>`);
    expect(lines[0]).toContain(`<t:${scheduledStartUnix}:R>`);
    expect(lines[0]).toContain("Season starts");
  });

  it("not started + no scheduledStartAt -> an explicit TBA line", () => {
    const lines = seasonWindowLines({ isActive: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TBA");
    expect(lines[0]).not.toContain("<t:");
  });

  it("active + scheduledEndAt set -> started line + end line, both with correct unix", () => {
    const lines = seasonWindowLines({ isActive: true, startedAt: started, scheduledEndAt: scheduledEnd });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`<t:${startedUnix}:F>`);
    expect(lines[0]).toContain("Started");
    expect(lines[1]).toContain(`<t:${scheduledEndUnix}:F>`);
    expect(lines[1]).toContain(`<t:${scheduledEndUnix}:R>`);
    expect(lines[1]).toContain("Ends");
  });

  it("active + no scheduledEndAt -> started line + explicit end-TBA line", () => {
    const lines = seasonWindowLines({ isActive: true, startedAt: started });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`<t:${startedUnix}:F>`);
    expect(lines[1]).toContain("TBA");
    expect(lines[1]).not.toContain("<t:");
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
