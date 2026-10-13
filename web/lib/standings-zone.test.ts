import { describe, expect, test } from "vitest";
import {
  boundaryArrowDirection,
  boundaryBelow,
  boundaryLabel,
  clinchTitle,
  zoneCertainty,
  zoneGlyphTitle,
  zoneKeyLines,
  zoneOf,
  type Zone,
  type ZoneCertainty,
  type ZoneExtras,
  type ZoneKeyLinesInput,
} from "./standings-zone";

describe("zoneOf", () => {
  test.each<[string, ZoneExtras | undefined, Zone]>([
    ["undefined extras -> no zone", undefined, undefined],
    ["empty extras -> no zone", {}, undefined],
    ["promoting -> promote", { promoting: true }, "promote"],
    ["relegating -> relegate", { relegating: true }, "relegate"],
    ["clinched up -> promote", { clinchStatus: "up" }, "promote"],
    ["clinched down -> relegate", { clinchStatus: "down" }, "relegate"],
    [
      "both promoting and relegating -> promote wins",
      { promoting: true, relegating: true },
      "promote",
    ],
    [
      "promoting true but clinchStatus down -> promote wins (checked first)",
      { promoting: true, clinchStatus: "down" },
      "promote",
    ],
  ])("%s", (_name, ex, expected) => {
    expect(zoneOf(ex)).toBe(expected);
  });
});

describe("zoneOf mid-season spots", () => {
  test("a row sitting in a promotion spot today is in the promote zone before anything is decided", () => {
    expect(zoneOf({ inPromotionSpot: true })).toBe("promote");
    expect(zoneOf({ inRelegationSpot: true })).toBe("relegate");
  });
  test("decided and clinched states still win over the current spot", () => {
    expect(zoneOf({ inRelegationSpot: true, clinchStatus: "up" })).toBe("promote");
    expect(zoneOf({ inPromotionSpot: true, relegating: true })).toBe("relegate");
  });
  test("a row in neither spot has no zone", () => {
    expect(zoneOf({ inPromotionSpot: false, inRelegationSpot: false })).toBeUndefined();
  });
});

describe("boundaryBelow", () => {
  test("empty table -> no boundary", () => {
    const zones: Zone[] = [];
    expect(boundaryBelow(zones, 0)).toBeUndefined();
  });

  test("single promoting row -> promote line below it (closes the zone)", () => {
    const zones: Zone[] = ["promote"];
    expect(boundaryBelow(zones, 0)).toBe("promote");
  });

  test("single relegating row, nothing above -> no line", () => {
    const zones: Zone[] = ["relegate"];
    expect(boundaryBelow(zones, 0)).toBeUndefined();
  });

  test("no promote/relegate anywhere -> no boundaries at all", () => {
    const zones: Zone[] = [undefined, undefined, undefined];
    for (let i = 0; i < zones.length; i++) {
      expect(boundaryBelow(zones, i)).toBeUndefined();
    }
  });

  test("typical division: 2 promote, 2 safe, 1 relegate", () => {
    const zones: Zone[] = ["promote", "promote", undefined, undefined, "relegate"];
    expect(boundaryBelow(zones, 0)).toBeUndefined(); // still inside promote zone
    expect(boundaryBelow(zones, 1)).toBe("promote"); // last promote row
    expect(boundaryBelow(zones, 2)).toBeUndefined(); // safe row, next also safe
    expect(boundaryBelow(zones, 3)).toBe("relegate"); // last safe row, next relegates
    expect(boundaryBelow(zones, 4)).toBeUndefined(); // last row in the table
  });

  test("promote zone touches relegate zone directly -> shared row reads promote", () => {
    const zones: Zone[] = ["promote", "relegate"];
    expect(boundaryBelow(zones, 0)).toBe("promote");
    expect(boundaryBelow(zones, 1)).toBeUndefined();
  });

  test("multiple relegate rows -> only the row above the first one gets a line", () => {
    const zones: Zone[] = [undefined, "relegate", "relegate"];
    expect(boundaryBelow(zones, 0)).toBe("relegate");
    expect(boundaryBelow(zones, 1)).toBeUndefined();
    expect(boundaryBelow(zones, 2)).toBeUndefined();
  });
});

describe("zoneKeyLines", () => {
  test("nothing applies -> no lines", () => {
    const input: ZoneKeyLinesInput = { promote: false, relegate: false };
    expect(zoneKeyLines(input)).toEqual([]);
  });

  test("promote only, with a neighbor name -> names the division above", () => {
    const input: ZoneKeyLinesInput = { promote: true, relegate: false, above: "Rare 1" };
    expect(zoneKeyLines(input)).toEqual([{ kind: "promote", text: "Promotion to Rare 1" }]);
  });

  test("promote only, no neighbor name -> bare verb fallback", () => {
    const input: ZoneKeyLinesInput = { promote: true, relegate: false };
    expect(zoneKeyLines(input)).toEqual([{ kind: "promote", text: "Promotion" }]);
  });

  test("relegate only, with a neighbor name -> names the division below", () => {
    const input: ZoneKeyLinesInput = { promote: false, relegate: true, below: "Common 2" };
    expect(zoneKeyLines(input)).toEqual([{ kind: "relegate", text: "Relegation to Common 2" }]);
  });

  test("relegate only, no neighbor name -> bare verb fallback", () => {
    const input: ZoneKeyLinesInput = { promote: false, relegate: true };
    expect(zoneKeyLines(input)).toEqual([{ kind: "relegate", text: "Relegation" }]);
  });

  test("everything applies -> promote, then relegate, in that order", () => {
    const input: ZoneKeyLinesInput = {
      promote: true,
      relegate: true,
      above: "Legendary",
      below: "Uncommon 1",
    };
    expect(zoneKeyLines(input)).toEqual([
      { kind: "promote", text: "Promotion to Legendary" },
      { kind: "relegate", text: "Relegation to Uncommon 1" },
    ]);
  });

  test("top division overall: no above name even if promote were somehow true -> falls back", () => {
    // Defensive case -- the page never sets promote=true without an `above`
    // once a division isn't first-overall, but the helper stays safe either way.
    const input: ZoneKeyLinesInput = { promote: true, relegate: false, above: undefined };
    expect(zoneKeyLines(input)[0]!.text).toBe("Promotion");
  });

  test("isTopOfLadder -> always 'Top of the ladder', even with promote false", () => {
    const input: ZoneKeyLinesInput = { promote: false, relegate: false, isTopOfLadder: true };
    expect(zoneKeyLines(input)).toEqual([{ kind: "promote", text: "Top of the ladder" }]);
  });

  test("isTopOfLadder wins over a named `above` (shouldn't happen together, but stays safe)", () => {
    const input: ZoneKeyLinesInput = { promote: true, relegate: false, above: "Rare 1", isTopOfLadder: true };
    expect(zoneKeyLines(input)).toEqual([{ kind: "promote", text: "Top of the ladder" }]);
  });

  test("bottom of the ladder: relegate false -> no relegation label at all", () => {
    const input: ZoneKeyLinesInput = { promote: true, relegate: false, above: "Rare 1", below: undefined };
    expect(zoneKeyLines(input).some((l) => l.kind === "relegate")).toBe(false);
  });
});

describe("boundaryLabel", () => {
  test("no boundary -> no label", () => {
    expect(boundaryLabel(undefined)).toBeUndefined();
  });

  test("promote boundary with a neighbor name", () => {
    expect(boundaryLabel("promote", "Rare 1", "Common 2")).toBe("Promotion to Rare 1");
  });

  test("promote boundary, no neighbor name -> bare fallback", () => {
    expect(boundaryLabel("promote")).toBe("Promotion");
  });

  test("relegate boundary with a neighbor name", () => {
    expect(boundaryLabel("relegate", "Rare 1", "Common 2")).toBe("Relegation to Common 2");
  });

  test("relegate boundary, no neighbor name -> bare fallback", () => {
    expect(boundaryLabel("relegate")).toBe("Relegation");
  });
});

describe("clinchTitle", () => {
  test("up -> clinched wording", () => {
    expect(clinchTitle("up")).toBe("Clinched: guaranteed up");
  });

  test("down -> locked wording", () => {
    expect(clinchTitle("down")).toBe("Locked: guaranteed down");
  });
});

describe("zoneCertainty", () => {
  test("no zone -> undefined regardless of extras", () => {
    expect(zoneCertainty({ promoting: true }, undefined)).toBeUndefined();
  });

  test.each<[string, ZoneExtras | undefined, Zone, ZoneCertainty | undefined]>([
    ["promoting -> decided", { promoting: true }, "promote", "decided"],
    ["relegating -> decided", { relegating: true }, "relegate", "decided"],
    ["clinched up -> decided", { clinchStatus: "up" }, "promote", "decided"],
    ["clinched down -> decided", { clinchStatus: "down" }, "relegate", "decided"],
    ["in promotion spot only -> spot", { inPromotionSpot: true }, "promote", "spot"],
    ["in relegation spot only -> spot", { inRelegationSpot: true }, "relegate", "spot"],
    [
      "clinched AND in the spot -> decided wins (same precedence as zoneOf)",
      { inPromotionSpot: true, clinchStatus: "up" },
      "promote",
      "decided",
    ],
    ["empty extras -> undefined", {}, "promote", undefined],
    ["no extras at all -> undefined", undefined, "relegate", undefined],
  ])("%s", (_name, ex, zone, expected) => {
    expect(zoneCertainty(ex, zone)).toBe(expected);
  });
});

describe("zoneGlyphTitle", () => {
  test("no zone -> undefined", () => {
    expect(zoneGlyphTitle(undefined, "decided")).toBeUndefined();
  });

  test("no certainty -> undefined", () => {
    expect(zoneGlyphTitle("promote", undefined)).toBeUndefined();
  });

  test("decided promote -> clinchTitle('up') wording", () => {
    expect(zoneGlyphTitle("promote", "decided")).toBe(clinchTitle("up"));
  });

  test("decided relegate -> clinchTitle('down') wording", () => {
    expect(zoneGlyphTitle("relegate", "decided")).toBe(clinchTitle("down"));
  });

  test("spot promote -> not-yet-guaranteed wording", () => {
    expect(zoneGlyphTitle("promote", "spot")).toBe("In the promotion spot -- not yet guaranteed");
  });

  test("spot relegate -> not-yet-guaranteed wording", () => {
    expect(zoneGlyphTitle("relegate", "spot")).toBe("In the relegation spot -- not yet guaranteed");
  });
});

describe("boundaryArrowDirection", () => {
  test("promote -> up", () => {
    expect(boundaryArrowDirection("promote")).toBe("up");
  });

  test("relegate -> down", () => {
    expect(boundaryArrowDirection("relegate")).toBe("down");
  });

  test("no boundary -> undefined", () => {
    expect(boundaryArrowDirection(undefined)).toBeUndefined();
  });
});
