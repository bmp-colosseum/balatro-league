// Table tests for the pure season-countdown core -- see
// season-countdown-core.ts's header for why day math is calendar-day based.
// Lives in web/lib so the ROOT vitest project picks it up (vitest.config.ts's
// `include: ["web/lib/**/*.test.ts"]`), same convention as health-core.test.ts.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { seasonCountdown, type SeasonCountdownInput, type SeasonCountdownResult } from "./season-countdown-core.js";

const DAY = 24 * 60 * 60 * 1000;
// A fixed "noon UTC" reference day so every case below reasons about whole
// calendar days without creeping into midnight-boundary surprises of its own.
const NOON = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z

describe("seasonCountdown", () => {
  it.each<[string, SeasonCountdownInput, SeasonCountdownResult]>([
    [
      "future scheduled end -> ends in N days",
      { startMs: NOON - 30 * DAY, scheduledEndMs: NOON + 6 * DAY, endedMs: null, nowMs: NOON },
      { kind: "ends", daysLeft: 6, label: "Ends in 6 days" },
    ],
    [
      "scheduled end later today -> ends today",
      { startMs: NOON - 30 * DAY, scheduledEndMs: NOON + 2 * 60 * 60 * 1000, endedMs: null, nowMs: NOON },
      { kind: "ends", daysLeft: 0, label: "Ends today" },
    ],
    [
      "scheduled end earlier today (still same calendar day) -> ends today",
      { startMs: NOON - 30 * DAY, scheduledEndMs: NOON - 2 * 60 * 60 * 1000, endedMs: null, nowMs: NOON },
      { kind: "ends", daysLeft: 0, label: "Ends today" },
    ],
    [
      "scheduled end in the past (different day), never formally ended -> ended N days ago",
      { startMs: NOON - 30 * DAY, scheduledEndMs: NOON - 3 * DAY, endedMs: null, nowMs: NOON },
      { kind: "ended", daysLeft: 3, label: "Ended 3 days ago" },
    ],
    [
      "formally ended (endedAt) takes priority over a different scheduledEndAt",
      { startMs: NOON - 30 * DAY, scheduledEndMs: NOON + 10 * DAY, endedMs: NOON - DAY, nowMs: NOON },
      { kind: "ended", daysLeft: 1, label: "Ended 1 day ago" },
    ],
    [
      "no end date set at all -> no-end-set",
      { startMs: NOON - 30 * DAY, scheduledEndMs: null, endedMs: null, nowMs: NOON },
      { kind: "no-end-set", daysLeft: null, label: "No end date set" },
    ],
    [
      "season hasn't started yet -> not-started, takes priority over end info",
      { startMs: NOON + 2 * DAY, scheduledEndMs: NOON + 40 * DAY, endedMs: null, nowMs: NOON },
      { kind: "not-started", daysLeft: 2, label: "Starts in 2 days" },
    ],
    [
      "season starts later today -> treated as already started (same calendar day)",
      { startMs: NOON + 3 * 60 * 60 * 1000, scheduledEndMs: null, endedMs: null, nowMs: NOON },
      { kind: "no-end-set", daysLeft: null, label: "No end date set" },
    ],
    [
      "singular day phrasing for exactly one day left",
      { startMs: NOON - 30 * DAY, scheduledEndMs: NOON + DAY, endedMs: null, nowMs: NOON },
      { kind: "ends", daysLeft: 1, label: "Ends in 1 day" },
    ],
  ])("%s", (_name, input, expected) => {
    expect(seasonCountdown(input)).toEqual(expected);
  });

  it("property: daysLeft is null iff kind is no-end-set, and otherwise non-negative", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -400, max: 400 }), // start offset in days from "now"
        fc.option(fc.integer({ min: -400, max: 400 }), { nil: null }), // scheduled end offset
        fc.option(fc.integer({ min: -400, max: 400 }), { nil: null }), // ended offset
        (startOffsetDays, scheduledOffsetDays, endedOffsetDays) => {
          const nowMs = NOON;
          const result = seasonCountdown({
            startMs: nowMs + startOffsetDays * DAY,
            scheduledEndMs: scheduledOffsetDays === null ? null : nowMs + scheduledOffsetDays * DAY,
            endedMs: endedOffsetDays === null ? null : nowMs + endedOffsetDays * DAY,
            nowMs,
          });
          expect(result.daysLeft === null).toBe(result.kind === "no-end-set");
          if (result.daysLeft !== null) {
            expect(result.daysLeft).toBeGreaterThanOrEqual(0);
          }
          expect(result.label.length).toBeGreaterThan(0);
        },
      ),
    );
  });
});
