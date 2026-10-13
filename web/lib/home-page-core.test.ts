import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  seasonMatchTotals,
  seasonProgressLine,
  topDivisionRows,
  type MatchCountSource,
  type TopDivisionSourceRow,
  type TopDivisionTierSource,
} from "./home-page-core";

describe("seasonMatchTotals", () => {
  test("no tiers -> zero totals", () => {
    expect(seasonMatchTotals([])).toEqual({ totalPlayed: 0, totalExpected: 0 });
  });

  test("sums played/expected across every division in every tier", () => {
    const tiers: MatchCountSource[] = [
      { divisions: [{ expectedMatches: 10, playedMatches: 4 }, { expectedMatches: 6, playedMatches: 6 }] },
      { divisions: [{ expectedMatches: 15, playedMatches: 0 }] },
    ];
    expect(seasonMatchTotals(tiers)).toEqual({ totalPlayed: 10, totalExpected: 31 });
  });

  test("tier with no divisions contributes nothing", () => {
    expect(seasonMatchTotals([{ divisions: [] }])).toEqual({ totalPlayed: 0, totalExpected: 0 });
  });

  test("conservation: total equals the sum of every individual division's own played/expected, order-independent", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ expectedMatches: fc.nat({ max: 50 }), playedMatches: fc.nat({ max: 50 }) }),
          { minLength: 0, maxLength: 20 },
        ),
        (divisions) => {
          const tiers: MatchCountSource[] = [{ divisions }];
          const shuffled: MatchCountSource[] = [{ divisions: [...divisions].reverse() }];
          const expectedPlayed = divisions.reduce((a, d) => a + d.playedMatches, 0);
          const expectedTotal = divisions.reduce((a, d) => a + d.expectedMatches, 0);
          expect(seasonMatchTotals(tiers)).toEqual({ totalPlayed: expectedPlayed, totalExpected: expectedTotal });
          // Order-independence -- summing doesn't care which division came first.
          expect(seasonMatchTotals(shuffled)).toEqual(seasonMatchTotals(tiers));
        },
      ),
    );
  });
});

describe("seasonProgressLine", () => {
  test.each<[string, { totalPlayed: number; totalExpected: number }, string]>([
    ["nothing scheduled yet", { totalPlayed: 0, totalExpected: 0 }, "No matches scheduled yet"],
    ["none played of a real total", { totalPlayed: 0, totalExpected: 20 }, "0 of 20 matches played (0%)"],
    ["partial progress rounds to nearest percent", { totalPlayed: 12, totalExpected: 174 }, "12 of 174 matches played (7%)"],
    ["fully played", { totalPlayed: 20, totalExpected: 20 }, "20 of 20 matches played (100%)"],
  ])("%s", (_name, input, expected) => {
    expect(seasonProgressLine(input)).toBe(expected);
  });

  test("percent always lands in [0, 100] for any totalPlayed within [0, totalExpected]", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), (a, b) => {
        const totalExpected = a + b; // totalExpected >= totalPlayed by construction
        const totalPlayed = a;
        const line = seasonProgressLine({ totalPlayed, totalExpected });
        if (totalExpected === 0) {
          expect(line).toBe("No matches scheduled yet");
          return;
        }
        const match = /\((\d+)%\)$/.exec(line);
        expect(match).not.toBeNull();
        const pct = Number(match![1]);
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }),
    );
  });
});

describe("topDivisionRows", () => {
  function tier(name: string, rows: TopDivisionSourceRow[]): TopDivisionTierSource<TopDivisionSourceRow> {
    return { name, divisions: [{ rows }] };
  }

  test("tier not present -> empty", () => {
    expect(topDivisionRows([tier("Common", [])], "Legendary", 3)).toEqual([]);
  });

  test("tier present but has no divisions -> empty", () => {
    expect(topDivisionRows([{ name: "Legendary", divisions: [] }], "Legendary", 3)).toEqual([]);
  });

  test("non-positive limit -> empty", () => {
    const rows = [{ player: { displayName: "Birb" }, points: 10 }];
    expect(topDivisionRows([tier("Legendary", rows)], "Legendary", 0)).toEqual([]);
    expect(topDivisionRows([tier("Legendary", rows)], "Legendary", -1)).toEqual([]);
  });

  test("takes the first division's top N rows in standings order, 1-indexed rank", () => {
    const rows = [
      { player: { displayName: "Birb" }, points: 30 },
      { player: { displayName: "Frankdeslimste" }, points: 25 },
      { player: { displayName: "Mangoman007" }, points: 20 },
    ];
    expect(topDivisionRows([tier("Legendary", rows)], "Legendary", 2)).toEqual([
      { rank: 1, displayName: "Birb", points: 30 },
      { rank: 2, displayName: "Frankdeslimste", points: 25 },
    ]);
  });

  test("limit larger than the row count returns every row, no padding", () => {
    const rows = [{ player: { displayName: "Birb" }, points: 10 }];
    expect(topDivisionRows([tier("Legendary", rows)], "Legendary", 5)).toEqual([
      { rank: 1, displayName: "Birb", points: 10 },
    ]);
  });

  test("only reads the named tier's FIRST division, ignoring a second division in the same tier", () => {
    const tierWithTwoDivisions: TopDivisionTierSource<TopDivisionSourceRow> = {
      name: "Legendary",
      divisions: [
        { rows: [{ player: { displayName: "First" }, points: 1 }] },
        { rows: [{ player: { displayName: "Second" }, points: 2 }] },
      ],
    };
    expect(topDivisionRows([tierWithTwoDivisions], "Legendary", 5)).toEqual([
      { rank: 1, displayName: "First", points: 1 },
    ]);
  });

  test("output length never exceeds min(limit, row count)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ displayName: fc.string({ minLength: 1 }), points: fc.integer() }), { maxLength: 10 }),
        fc.integer({ min: -5, max: 15 }),
        (plainRows, limit) => {
          const rows = plainRows.map((r) => ({ player: { displayName: r.displayName }, points: r.points }));
          const result = topDivisionRows([tier("Legendary", rows)], "Legendary", limit);
          expect(result.length).toBeLessThanOrEqual(Math.max(0, limit));
          expect(result.length).toBeLessThanOrEqual(rows.length);
          // Round-trip: every returned row's displayName/points match the
          // source row at the same (rank - 1) index.
          for (const r of result) {
            expect(r.displayName).toBe(rows[r.rank - 1]!.player.displayName);
            expect(r.points).toBe(rows[r.rank - 1]!.points);
          }
        },
      ),
    );
  });
});
