import { describe, it, expect } from "vitest";
import { seasonWindowLinesPlain } from "./season-window-text.js";

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
