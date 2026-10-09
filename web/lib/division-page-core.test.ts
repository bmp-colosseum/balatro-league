import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { groupPairings, type Pairing, type PairingParticipant } from "./division-page-core.js";

const p = (id: string, displayName = id): PairingParticipant => ({ id, displayName });

const unplayed = (aId: string, bId: string): Pairing => ({
  played: false,
  a: p(aId),
  b: p(bId),
});

const played = (aId: string, bId: string, date: Date | null, scoreA = 2, scoreB = 1): Pairing => ({
  played: true,
  id: `${aId}-${bId}-${date ? date.toISOString() : "null"}`,
  date,
  a: p(aId),
  b: p(bId),
  scoreA,
  scoreB,
  forfeit: false,
});

describe("groupPairings -- table-driven scenarios", () => {
  it("puts every pairing involving the viewer into `yours`, regardless of played state", () => {
    const pairings = [
      unplayed("viewer", "p2"),
      unplayed("p3", "p4"),
      played("viewer", "p5", new Date("2026-01-01")),
      played("p6", "p7", new Date("2026-01-02")),
    ];
    const result = groupPairings(pairings, "viewer");
    expect(result.yours.map((x) => [x.a.id, x.b.id])).toEqual([
      ["viewer", "p2"],
      ["viewer", "p5"],
    ]);
    expect(result.toPlay.map((x) => [x.a.id, x.b.id])).toEqual([["p3", "p4"]]);
    expect(result.played.map((x) => [x.a.id, x.b.id])).toEqual([["p6", "p7"]]);
  });

  it("puts unplayed viewer matches before played viewer matches within `yours`", () => {
    const pairings = [
      played("viewer", "p2", new Date("2026-01-05")),
      unplayed("viewer", "p3"),
    ];
    const result = groupPairings(pairings, "viewer");
    expect(result.yours.map((x) => x.played)).toEqual([false, true]);
  });

  it("sorts the played group newest-first", () => {
    const pairings = [
      played("a", "b", new Date("2026-01-01")),
      played("c", "d", new Date("2026-03-01")),
      played("e", "f", new Date("2026-02-01")),
    ];
    const result = groupPairings(pairings, null);
    expect(result.played.map((x) => x.a.id)).toEqual(["c", "e", "a"]);
  });

  it("sorts played viewer matches newest-first within `yours` too", () => {
    const pairings = [
      played("viewer", "a", new Date("2026-01-01")),
      played("viewer", "b", new Date("2026-03-01")),
      played("viewer", "c", new Date("2026-02-01")),
    ];
    const result = groupPairings(pairings, "viewer");
    expect(result.yours.map((x) => x.b.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts a null-dated played pairing to the end", () => {
    const pairings = [
      played("a", "b", null),
      played("c", "d", new Date("2026-01-01")),
    ];
    const result = groupPairings(pairings, null);
    expect(result.played.map((x) => x.a.id)).toEqual(["c", "a"]);
  });

  it("puts everything into toPlay/played with no `yours` group when signed out", () => {
    const pairings = [unplayed("a", "b"), played("c", "d", new Date("2026-01-01"))];
    const result = groupPairings(pairings, null);
    expect(result.yours).toEqual([]);
    expect(result.toPlay).toHaveLength(1);
    expect(result.played).toHaveLength(1);
  });

  it("never duplicates or drops a pairing across the three groups", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            played: fc.boolean(),
            aId: fc.constantFrom("p1", "p2", "p3", "p4", "viewer"),
            bId: fc.constantFrom("p1", "p2", "p3", "p4", "viewer"),
            day: fc.integer({ min: 1, max: 28 }),
          }),
          { maxLength: 20 },
        ),
        (specs) => {
          const pairings: Pairing[] = specs.map((s, i) =>
            s.played
              ? played(s.aId, s.bId + i, new Date(2026, 0, s.day))
              : unplayed(s.aId, s.bId + i),
          );
          const result = groupPairings(pairings, "viewer");
          const total = result.yours.length + result.toPlay.length + result.played.length;
          expect(total).toBe(pairings.length);
          // Every input pairing (by identity) appears in exactly one bucket.
          const buckets = [result.yours, result.toPlay, result.played];
          for (const pairing of pairings) {
            const count = buckets.reduce((n, bucket) => n + (bucket.includes(pairing) ? 1 : 0), 0);
            expect(count).toBe(1);
          }
        },
      ),
    );
  });
});
