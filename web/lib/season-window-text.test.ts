import { describe, it, expect } from "vitest";
import { seasonWindowLinesPlain, seasonWindowDates } from "./season-window-text.js";

describe("seasonWindowLinesPlain", () => {
  it("returns [] for an inactive season with no scheduled start (evergreen fallback is the guide's own)", () => {
    expect(seasonWindowLinesPlain({ isActive: false })).toEqual([]);
  });

  it("returns a single 'Season starts ...' line for an inactive season with a scheduled start", () => {
    const lines = seasonWindowLinesPlain({ isActive: false, scheduledStartAt: new Date("2026-11-03T00:00:00Z") });
    expect(lines).toEqual(["Season starts November 3, 2026"]);
  });

  it("returns a 'Started ...' + 'Ends around ...' pair for an active season with a scheduled end", () => {
    const lines = seasonWindowLinesPlain({
      isActive: true,
      startedAt: new Date("2026-10-01T00:00:00Z"),
      scheduledEndAt: new Date("2026-10-15T00:00:00Z"),
    });
    expect(lines).toEqual(["Started October 1, 2026", "Ends around October 15, 2026"]);
  });

  it("returns only the 'Started ...' line for an active season with no scheduled end", () => {
    const lines = seasonWindowLinesPlain({ isActive: true, startedAt: new Date("2026-10-01T00:00:00Z") });
    expect(lines).toEqual(["Started October 1, 2026"]);
  });

  it("falls back to 'Started recently' when active but startedAt is missing", () => {
    expect(seasonWindowLinesPlain({ isActive: true })).toEqual(["Started recently"]);
  });
});

describe("seasonWindowDates", () => {
  it("returns [] for an inactive season with no scheduled start", () => {
    expect(seasonWindowDates({ isActive: false })).toEqual([]);
  });

  it("returns the scheduled-start date for an inactive season with one", () => {
    const d = new Date("2026-11-03T00:00:00Z");
    expect(seasonWindowDates({ isActive: false, scheduledStartAt: d })).toEqual([
      { iso: d.toISOString(), fallback: "November 3, 2026" },
    ]);
  });

  it("returns started + scheduled-end dates, in that order, for an active season with both", () => {
    const started = new Date("2026-10-01T00:00:00Z");
    const ends = new Date("2026-10-15T00:00:00Z");
    expect(seasonWindowDates({ isActive: true, startedAt: started, scheduledEndAt: ends })).toEqual([
      { iso: started.toISOString(), fallback: "October 1, 2026" },
      { iso: ends.toISOString(), fallback: "October 15, 2026" },
    ]);
  });

  it("returns only the started date when there's no scheduled end", () => {
    const started = new Date("2026-10-01T00:00:00Z");
    expect(seasonWindowDates({ isActive: true, startedAt: started })).toEqual([
      { iso: started.toISOString(), fallback: "October 1, 2026" },
    ]);
  });

  it("returns [] when active but startedAt is missing (the 'Started recently' case has no date to sync)", () => {
    expect(seasonWindowDates({ isActive: true })).toEqual([]);
  });

  it("every fallback matches the corresponding seasonWindowLinesPlain line verbatim", () => {
    const opts = {
      isActive: true,
      startedAt: new Date("2026-10-08T03:00:00Z"),
      scheduledEndAt: new Date("2026-10-22T03:00:00Z"),
    };
    const lines = seasonWindowLinesPlain(opts);
    const dates = seasonWindowDates(opts);
    expect(dates).toHaveLength(2);
    for (const { fallback } of dates) {
      expect(lines.some((line) => line.includes(fallback))).toBe(true);
    }
  });
});
