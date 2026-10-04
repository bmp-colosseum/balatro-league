import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computePlayTimes,
  busiestHourWindow,
  busiestWeekday,
  quietestWeekday,
  overallLastThreeDaysShare,
  type PlayTimesInput,
  type PlayTimesMatch,
  type PlayTimesSeason,
  type PlayTimesSeasonSummary,
} from "./play-times-core.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

// 2026-01-05 is a Monday (UTC) -- a stable anchor for weekday math in tests.
const MONDAY_UTC = Date.UTC(2026, 0, 5, 0, 0, 0);

function atUtc(dayOffset: number, hour: number, minute = 0): number {
  return MONDAY_UTC + dayOffset * DAY_MS + hour * HOUR_MS + minute * 60_000;
}

function sum(ns: readonly number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

describe("computePlayTimes -- table-driven scenarios", () => {
  it("buckets a single match into its local weekday + hour, no offset", () => {
    const matches: PlayTimesMatch[] = [{ seasonNumber: 1, atMs: atUtc(0, 14) }]; // Monday 14:00 UTC
    const seasons: PlayTimesSeason[] = [{ number: 1, startMs: atUtc(0, 0), endMs: null, active: true }];
    const result = computePlayTimes({ matches, seasons, tzOffsetMinutes: 0 });

    expect(result.kept).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.heat[0][14]).toBe(1); // Monday, 14:00
    expect(result.hours[14]).toBe(1);
    expect(result.weekdays[0]).toBe(1);
  });

  it("shifts into the previous local weekday when a positive tz offset crosses midnight", () => {
    // Monday 00:30 UTC, viewer at UTC-6 (offset minutes = +360 per getTimezoneOffset()
    // convention) -> local time is Sunday 18:30.
    const matches: PlayTimesMatch[] = [{ seasonNumber: 1, atMs: atUtc(0, 0, 30) }];
    const seasons: PlayTimesSeason[] = [{ number: 1, startMs: atUtc(0, 0), endMs: null, active: true }];
    const result = computePlayTimes({ matches, seasons, tzOffsetMinutes: 360 });

    expect(result.heat[6][18]).toBe(1); // Sunday, 18:00
    expect(result.weekdays[6]).toBe(1);
    expect(result.weekdays[0]).toBe(0);
  });

  it("drops a UTC-minute bucket with 5+ confirmations as an import batch, keeps a bucket of 4", () => {
    const importMinute = atUtc(0, 10, 0);
    const organicMinute = atUtc(1, 11, 0);
    const matches: PlayTimesMatch[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ seasonNumber: 1, atMs: importMinute + i * 1 })),
      ...Array.from({ length: 4 }, (_, i) => ({ seasonNumber: 1, atMs: organicMinute + i * 1 })),
    ];
    const seasons: PlayTimesSeason[] = [{ number: 1, startMs: atUtc(0, 0), endMs: null, active: true }];
    const result = computePlayTimes({ matches, seasons, tzOffsetMinutes: 0 });

    expect(result.dropped).toBe(5);
    expect(result.kept).toBe(4);
    expect(result.hours[11]).toBe(4);
    expect(result.hours[10]).toBe(0);
  });

  it("places matches into per-season day buckets from the season's start day, and marks endDay", () => {
    const seasonStart = atUtc(0, 9); // day 0, 09:00
    const seasonEnd = atUtc(10, 9); // day 10, 09:00
    const matches: PlayTimesMatch[] = [
      { seasonNumber: 1, atMs: atUtc(0, 10) }, // day 0
      { seasonNumber: 1, atMs: atUtc(1, 10) }, // day 1
      { seasonNumber: 1, atMs: atUtc(1, 20) }, // day 1
      { seasonNumber: 1, atMs: atUtc(9, 10) }, // day 9 -> within last 3 days of a day-10 end
    ];
    const seasons: PlayTimesSeason[] = [{ number: 1, startMs: seasonStart, endMs: seasonEnd, active: false }];
    const result = computePlayTimes({ matches, seasons, tzOffsetMinutes: 0 });

    expect(result.perSeason).toHaveLength(1);
    const s = result.perSeason[0]!;
    expect(s.endDay).toBe(10);
    expect(s.dayCounts[0]).toBe(1);
    expect(s.dayCounts[1]).toBe(2);
    expect(s.dayCounts).toHaveLength(11); // days 0..10 inclusive
    expect(s.total).toBe(4);
    expect(s.lastThreeDays).toBe(1); // only day 9 is within [endDay-2, endDay] = [8,10]
  });

  it("falls back to the data's own last-played day for lastThreeDays when a season has no known end", () => {
    const seasonStart = atUtc(0, 9);
    const matches: PlayTimesMatch[] = [
      { seasonNumber: 1, atMs: atUtc(0, 10) }, // day 0
      { seasonNumber: 1, atMs: atUtc(4, 10) }, // day 4 (the latest played day)
      { seasonNumber: 1, atMs: atUtc(5, 10) }, // day 5
    ];
    const seasons: PlayTimesSeason[] = [{ number: 1, startMs: seasonStart, endMs: null, active: true }];
    const result = computePlayTimes({ matches, seasons, tzOffsetMinutes: 0 });

    const s = result.perSeason[0]!;
    expect(s.endDay).toBeNull();
    // Max played day is 5 -> window is [3,5] -> days 4 and 5 count, day 0 doesn't.
    expect(s.lastThreeDays).toBe(2);
  });

  it("clamps a match timestamped before its season's recorded start onto day 0", () => {
    const seasonStart = atUtc(5, 9);
    const matches: PlayTimesMatch[] = [{ seasonNumber: 1, atMs: atUtc(0, 10) }]; // before season start
    const seasons: PlayTimesSeason[] = [{ number: 1, startMs: seasonStart, endMs: null, active: true }];
    const result = computePlayTimes({ matches, seasons, tzOffsetMinutes: 0 });

    expect(result.perSeason[0]!.dayCounts[0]).toBe(1);
  });

  it("returns a zeroed, empty-shaped result for no matches and no seasons", () => {
    const result = computePlayTimes({ matches: [], seasons: [], tzOffsetMinutes: 0 });
    expect(result.kept).toBe(0);
    expect(result.dropped).toBe(0);
    expect(sum(result.hours)).toBe(0);
    expect(sum(result.weekdays)).toBe(0);
    expect(result.perSeason).toHaveLength(0);
  });

  it("sorts perSeason by season number regardless of input order", () => {
    const seasons: PlayTimesSeason[] = [
      { number: 3, startMs: atUtc(0, 0), endMs: null, active: true },
      { number: 1, startMs: atUtc(0, 0), endMs: null, active: false },
      { number: 2, startMs: atUtc(0, 0), endMs: null, active: false },
    ];
    const matches = [3, 1, 2].map((seasonNumber) => ({ seasonNumber, atMs: atUtc(0, 12) }));
    const result = computePlayTimes({ matches, seasons, tzOffsetMinutes: 0 });
    expect(result.perSeason.map((s) => s.number)).toEqual([1, 2, 3]);
  });
});

describe("busiestHourWindow", () => {
  it("picks the contiguous 4-hour window with the highest total, wrapping past midnight", () => {
    const hours = new Array(24).fill(0);
    hours[22] = 3;
    hours[23] = 4;
    hours[0] = 5;
    hours[1] = 2; // window [22,23,0,1] = 14, beats any non-wrapping window
    const result = busiestHourWindow(hours, 14);
    expect(result.startHour).toBe(22);
    expect(result.total).toBe(14);
    expect(result.share).toBe(1);
  });

  it("breaks ties toward the earliest start hour", () => {
    const hours = new Array(24).fill(1); // every window sums to 4
    const result = busiestHourWindow(hours, 24);
    expect(result.startHour).toBe(0);
    expect(result.total).toBe(4);
  });

  it("returns a zero window with zero share for an all-zero/empty day", () => {
    expect(busiestHourWindow(new Array(24).fill(0), 0)).toEqual({
      startHour: 0,
      lengthHours: 4,
      total: 0,
      share: 0,
    });
    expect(busiestHourWindow([], 0).total).toBe(0);
  });
});

describe("busiestWeekday / quietestWeekday", () => {
  it("picks the max and min, breaking ties toward the earliest index", () => {
    const weekdays = [5, 5, 1, 1, 9, 0, 0];
    expect(busiestWeekday(weekdays)).toEqual({ weekday: 4, total: 9 });
    expect(quietestWeekday(weekdays)).toEqual({ weekday: 5, total: 0 });
  });

  it("handles an empty input without throwing", () => {
    expect(busiestWeekday([])).toEqual({ weekday: 0, total: 0 });
    expect(quietestWeekday([])).toEqual({ weekday: 0, total: 0 });
  });
});

describe("overallLastThreeDaysShare", () => {
  it("weights by match count across seasons, not by season count", () => {
    const perSeason: PlayTimesSeasonSummary[] = [
      { number: 1, active: false, dayCounts: [], endDay: null, total: 100, lastThreeDays: 10 },
      { number: 2, active: true, dayCounts: [], endDay: null, total: 10, lastThreeDays: 10 },
    ];
    // (10 + 10) / (100 + 10) = 20/110
    expect(overallLastThreeDaysShare(perSeason)).toBeCloseTo(20 / 110, 10);
  });

  it("is 0 when there are no matches at all", () => {
    expect(overallLastThreeDaysShare([])).toBe(0);
    expect(
      overallLastThreeDaysShare([{ number: 1, active: true, dayCounts: [], endDay: null, total: 0, lastThreeDays: 0 }]),
    ).toBe(0);
  });
});

// --- Property-based invariants -------------------------------------------

const seasonNumberArb = fc.integer({ min: 1, max: 6 });

// Builds { seasons, tzOffsetMinutes, matches } as one arbitrary -- matches'
// seasonNumber draws from the SAME seasonNumbers list used to build seasons,
// so every kept match lands in exactly one perSeason bucket (the real
// contract between the shell's loader and this core).
const playTimesInputArb: fc.Arbitrary<PlayTimesInput> = fc
  .tuple(
    fc.uniqueArray(seasonNumberArb, { minLength: 1, maxLength: 4 }),
    fc.integer({ min: -720, max: 720 }),
  )
  .chain(([seasonNumbers, tzOffsetMinutes]) => {
    const seasons: PlayTimesSeason[] = seasonNumbers.map((number, i) => ({
      number,
      startMs: atUtc(0, 0) + i, // arbitrary distinct anchors, order doesn't matter for these properties
      endMs: null,
      active: i === seasonNumbers.length - 1,
    }));
    const matchArb = fc.record<PlayTimesMatch>({
      seasonNumber: fc.constantFrom(...seasonNumbers),
      // Spread matches across a wide-but-bounded window of UTC minutes so
      // fast-check can still stumble onto >=5-in-one-minute import batches.
      atMs: fc.integer({ min: atUtc(0, 0), max: atUtc(0, 0) + 2000 * 60_000 }),
    });
    return fc.array(matchArb, { maxLength: 60 }).map((matches) => ({ matches, seasons, tzOffsetMinutes }));
  });

describe("computePlayTimes -- properties", () => {
  it("conserves counts: kept+dropped == input length, and heat/hours/weekdays/perSeason totals all equal kept", () => {
    fc.assert(
      fc.property(playTimesInputArb, (input) => {
        const result = computePlayTimes(input);

        expect(result.kept + result.dropped).toBe(input.matches.length);
        expect(sum(result.hours)).toBe(result.kept);
        expect(sum(result.weekdays)).toBe(result.kept);
        expect(sum(result.heat.map(sum))).toBe(result.kept);
        expect(sum(result.perSeason.map((s) => s.total))).toBe(result.kept);
      }),
    );
  });

  it("is order-independent: shuffling the input matches never changes the result", () => {
    fc.assert(
      fc.property(playTimesInputArb, fc.integer({ min: 0, max: 2 ** 31 - 1 }), (input, seed) => {
        const shuffled = fc.sample(fc.shuffledSubarray(input.matches, { minLength: input.matches.length }), {
          seed,
          numRuns: 1,
        })[0]!;
        const a = computePlayTimes(input);
        const b = computePlayTimes({ ...input, matches: shuffled });
        expect(b).toEqual(a);
      }),
    );
  });

  it("derived summary helpers stay consistent with computePlayTimes' own totals", () => {
    fc.assert(
      fc.property(playTimesInputArb, (input) => {
        const result = computePlayTimes(input);

        const window = busiestHourWindow(result.hours, result.kept);
        expect(window.total).toBeLessThanOrEqual(result.kept);
        expect(window.share).toBeGreaterThanOrEqual(0);
        expect(window.share).toBeLessThanOrEqual(1);

        const busiest = busiestWeekday(result.weekdays);
        const quietest = quietestWeekday(result.weekdays);
        expect(busiest.total).toBeGreaterThanOrEqual(quietest.total);
        expect(sum(result.weekdays)).toBe(result.kept);

        const share = overallLastThreeDaysShare(result.perSeason);
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("computePlayTimes: seasons without play", () => {
  it("leaves out a season that has no kept matches", () => {
    const result = computePlayTimes({
      matches: [{ seasonNumber: 1, atMs: Date.UTC(2026, 4, 31, 18, 0) }],
      seasons: [
        { number: 1, startMs: Date.UTC(2026, 4, 30), endMs: Date.UTC(2026, 5, 20), active: false },
        { number: 2, startMs: Date.UTC(2026, 8, 30), endMs: null, active: false },
      ],
      tzOffsetMinutes: 0,
    });
    expect(result.perSeason.map((s) => s.number)).toEqual([1]);
  });
});
