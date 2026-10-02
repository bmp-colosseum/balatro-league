// Property tests for the "best BMP snapshot" pick: highest tagged bmpSeason
// wins, then most recent capture. loadBestBmpSnapshotsForPlayerIds (SQL
// DISTINCT ON) is built to match this exact preference — see the regex/
// COALESCE ordering comment there. This file stays import-free (no "@/"
// aliases, no prisma) so it runs under the root vitest project alongside
// host-metrics-parsers.test.ts; see vitest.config.ts's `include`.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { bmpSeasonNumber, byBestBmpSnapshot } from "./bmp-snapshots.js";

describe("bmpSeasonNumber", () => {
  it("parses the numeric suffix of a season tag", () => {
    expect(bmpSeasonNumber("season6")).toBe(6);
    expect(bmpSeasonNumber("season10")).toBe(10);
  });

  it("treats null and non-matching tags as -Infinity (sort last)", () => {
    expect(bmpSeasonNumber(null)).toBe(-Infinity);
    expect(bmpSeasonNumber("ad-hoc")).toBe(-Infinity);
    expect(bmpSeasonNumber("")).toBe(-Infinity);
  });
});

const snapshotArb = fc.record({
  bmpSeason: fc.option(fc.nat({ max: 20 }).map((n) => `season${n}`), { nil: null }),
  capturedAt: fc
    .integer({ min: 0, max: 1_000_000_000 })
    .map((ms) => new Date(ms)),
});

describe("byBestBmpSnapshot", () => {
  it("sorts a season tag strictly above any lower season tag, regardless of capturedAt", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        snapshotArb,
        snapshotArb,
        (hi, lo, a, b) => {
          fc.pre(hi > lo);
          const high = { ...a, bmpSeason: `season${hi}` };
          const low = { ...b, bmpSeason: `season${lo}` };
          // "high" must sort before "low" (negative = a before b) no matter
          // which side of the comparator call it's on.
          expect(byBestBmpSnapshot(high, low)).toBeLessThan(0);
          expect(byBestBmpSnapshot(low, high)).toBeGreaterThan(0);
        },
      ),
    );
  });

  it("within the same season tag, prefers the most recently captured snapshot", () => {
    fc.assert(
      fc.property(fc.nat({ max: 20 }), fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 1e9 }), (season, t1, t2) => {
        fc.pre(t1 !== t2);
        const a = { bmpSeason: `season${season}`, capturedAt: new Date(t1) };
        const b = { bmpSeason: `season${season}`, capturedAt: new Date(t2) };
        const newer = t1 > t2 ? a : b;
        const older = t1 > t2 ? b : a;
        expect(byBestBmpSnapshot(newer, older)).toBeLessThan(0);
      }),
    );
  });

  it("picking the min by this comparator out of a shuffled list is order-independent", () => {
    fc.assert(
      fc.property(fc.array(snapshotArb, { minLength: 1, maxLength: 30 }), (snaps) => {
        const sortedA = [...snaps].sort(byBestBmpSnapshot);
        const sortedB = [...snaps].reverse().sort(byBestBmpSnapshot);
        expect(sortedA[0]).toEqual(sortedB[0]);
      }),
    );
  });

  it("an untagged (null bmpSeason) snapshot never outranks any tagged snapshot", () => {
    fc.assert(
      fc.property(fc.nat({ max: 20 }), snapshotArb, snapshotArb, (season, a, b) => {
        const tagged = { ...a, bmpSeason: `season${season}` };
        const untagged = { ...b, bmpSeason: null };
        expect(byBestBmpSnapshot(tagged, untagged)).toBeLessThan(0);
      }),
    );
  });
});
