import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  buildLadder,
  promotionTarget,
  relegationTarget,
  type LadderDivisionInput,
} from "./division-ladder";

function div(overrides: Partial<LadderDivisionInput> & Pick<LadderDivisionInput, "id" | "name">): LadderDivisionInput {
  return {
    tierName: "Common",
    tierPosition: 4,
    groupNumber: 1,
    promote: 0,
    relegate: 0,
    ...overrides,
  };
}

describe("buildLadder", () => {
  test("empty input -> empty ladder", () => {
    expect(buildLadder([])).toEqual([]);
  });

  test("single division -> both ends null, rung 1 of 1", () => {
    const [rung] = buildLadder([div({ id: "a", name: "Legendary" })]);
    expect(rung!.above).toBeNull();
    expect(rung!.below).toBeNull();
    expect(rung!.ladderPosition).toBe("1 of 1");
  });

  test("orders by tier position ascending, then group number ascending within a tier", () => {
    const input: LadderDivisionInput[] = [
      div({ id: "common2", name: "Common 2", tierName: "Common", tierPosition: 4, groupNumber: 2 }),
      div({ id: "legendary", name: "Legendary", tierName: "Legendary", tierPosition: 1, groupNumber: 1 }),
      div({ id: "common1", name: "Common 1", tierName: "Common", tierPosition: 4, groupNumber: 1 }),
      div({ id: "rare1", name: "Rare 1", tierName: "Rare", tierPosition: 2, groupNumber: 1 }),
    ];
    const ladder = buildLadder(input);
    expect(ladder.map((r) => r.id)).toEqual(["legendary", "rare1", "common1", "common2"]);
  });

  test("Season 1 naming ('Common A (1)') is kept as stored, not renamed", () => {
    const [rung] = buildLadder([div({ id: "a", name: "Common A (1)" })]);
    expect(rung!.name).toBe("Common A (1)");
  });

  test("the top of Common 4 promotes into Common 3; the bottom of Common 3 relegates into Common 4", () => {
    const input: LadderDivisionInput[] = [
      div({ id: "c3", name: "Common 3", groupNumber: 3, promote: 1, relegate: 1 }),
      div({ id: "c4", name: "Common 4", groupNumber: 4, promote: 1, relegate: 0 }),
    ];
    const ladder = buildLadder(input);
    const c3 = ladder.find((r) => r.id === "c3")!;
    const c4 = ladder.find((r) => r.id === "c4")!;
    expect(promotionTarget(c4)).toBe("Common 3");
    expect(relegationTarget(c3)).toBe("Common 4");
  });

  test("names, tierName, and the hand-set promote/relegate counts are preserved verbatim", () => {
    const input: LadderDivisionInput[] = [
      div({ id: "a", name: "Rare 1", tierName: "Rare", tierPosition: 2, groupNumber: 1, promote: 2, relegate: 3 }),
    ];
    const [rung] = buildLadder(input);
    expect(rung!.name).toBe("Rare 1");
    expect(rung!.tierName).toBe("Rare");
    expect(rung!.promote).toBe(2);
    expect(rung!.relegate).toBe(3);
  });
});

describe("promotionTarget / relegationTarget", () => {
  test("top rung has no promotion target", () => {
    const [top] = buildLadder([
      div({ id: "top", name: "Legendary", tierPosition: 1, groupNumber: 1 }),
      div({ id: "mid", name: "Rare 1", tierPosition: 2, groupNumber: 1 }),
    ]);
    expect(promotionTarget(top!)).toBeNull();
  });

  test("bottom rung has no relegation target", () => {
    const ladder = buildLadder([
      div({ id: "mid", name: "Rare 1", tierPosition: 2, groupNumber: 1 }),
      div({ id: "bottom", name: "Common 4", tierPosition: 4, groupNumber: 4 }),
    ]);
    const bottom = ladder.find((r) => r.id === "bottom")!;
    expect(relegationTarget(bottom)).toBeNull();
  });
});

// ---- Property-based invariants -----------------------------------------

const divisionArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 20 }),
  tierName: fc.string({ minLength: 1, maxLength: 20 }),
  tierPosition: fc.integer({ min: 1, max: 6 }),
  groupNumber: fc.integer({ min: 1, max: 6 }),
  promote: fc.integer({ min: 0, max: 4 }),
  relegate: fc.integer({ min: 0, max: 4 }),
});

// Unique ids so each division is distinguishable -- buildLadder tolerates
// duplicate (tierPosition, groupNumber) pairs (tiebreaks on id), but a real
// ladder never has two divisions sharing both an id and a position, so this
// keeps the arbitrary inputs realistic.
const ladderArb = fc
  .uniqueArray(divisionArb, { selector: (d) => d.id, minLength: 0, maxLength: 12 });

describe("buildLadder properties", () => {
  test("ends are null: the first rung has no above, the last has no below", () => {
    fc.assert(
      fc.property(ladderArb, (divisions) => {
        const ladder = buildLadder(divisions);
        if (ladder.length === 0) return;
        expect(ladder[0]!.above).toBeNull();
        expect(ladder[ladder.length - 1]!.below).toBeNull();
      }),
    );
  });

  test("order invariant: every rung's below.above points back to itself", () => {
    fc.assert(
      fc.property(ladderArb, (divisions) => {
        const ladder = buildLadder(divisions);
        for (let i = 0; i < ladder.length - 1; i++) {
          const rung = ladder[i]!;
          const nextRung = ladder[i + 1]!;
          expect(rung.below?.id).toBe(nextRung.id);
          expect(nextRung.above?.id).toBe(rung.id);
        }
      }),
    );
  });

  test("names and promote/relegate counts are preserved for every division", () => {
    fc.assert(
      fc.property(ladderArb, (divisions) => {
        const ladder = buildLadder(divisions);
        const byId = new Map(divisions.map((d) => [d.id, d]));
        for (const rung of ladder) {
          const original = byId.get(rung.id)!;
          expect(rung.name).toBe(original.name);
          expect(rung.tierName).toBe(original.tierName);
          expect(rung.promote).toBe(original.promote);
          expect(rung.relegate).toBe(original.relegate);
        }
      }),
    );
  });

  test("ladderPosition/rung/total are consistent and 1-based", () => {
    fc.assert(
      fc.property(ladderArb, (divisions) => {
        const ladder = buildLadder(divisions);
        ladder.forEach((rung, i) => {
          expect(rung.rung).toBe(i + 1);
          expect(rung.total).toBe(ladder.length);
          expect(rung.ladderPosition).toBe(`${i + 1} of ${ladder.length}`);
        });
      }),
    );
  });

  test("stable for any permutation of the input -- output order never depends on input order", () => {
    fc.assert(
      fc.property(ladderArb, fc.integer({ min: 0, max: 2 ** 31 - 1 }), (divisions, seed) => {
        // Deterministic shuffle derived from the seed (Fisher-Yates).
        const shuffled = [...divisions];
        let s = seed;
        const nextRand = (): number => {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          return s;
        };
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = nextRand() % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        const a = buildLadder(divisions).map((r) => r.id);
        const b = buildLadder(shuffled).map((r) => r.id);
        expect(b).toEqual(a);
      }),
    );
  });

  test("every division in the input appears exactly once in the ladder", () => {
    fc.assert(
      fc.property(ladderArb, (divisions) => {
        const ladder = buildLadder(divisions);
        expect(ladder.length).toBe(divisions.length);
        const ladderIds = new Set(ladder.map((r) => r.id));
        expect(ladderIds.size).toBe(divisions.length);
        for (const d of divisions) expect(ladderIds.has(d.id)).toBe(true);
      }),
    );
  });
});
