import { describe, expect, test } from "vitest";
import { boundaryBelow, zoneKeyLines, zoneOf, type Zone, type ZoneExtras, type ZoneKeyLinesInput } from "./standings-zone";

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
    expect(zoneKeyLines(input)).toEqual([{ kind: "promote", text: "Promotes to Rare 1" }]);
  });

  test("promote only, no neighbor name -> bare verb fallback", () => {
    const input: ZoneKeyLinesInput = { promote: true, relegate: false };
    expect(zoneKeyLines(input)).toEqual([{ kind: "promote", text: "Promotes" }]);
  });

  test("relegate only, with a neighbor name -> names the division below", () => {
    const input: ZoneKeyLinesInput = { promote: false, relegate: true, below: "Common 2" };
    expect(zoneKeyLines(input)).toEqual([{ kind: "relegate", text: "Drops to Common 2" }]);
  });

  test("relegate only, no neighbor name -> bare verb fallback", () => {
    const input: ZoneKeyLinesInput = { promote: false, relegate: true };
    expect(zoneKeyLines(input)).toEqual([{ kind: "relegate", text: "Drops" }]);
  });

  test("everything applies -> promote, then relegate, in that order", () => {
    const input: ZoneKeyLinesInput = {
      promote: true,
      relegate: true,
      above: "Legendary",
      below: "Uncommon 1",
    };
    expect(zoneKeyLines(input)).toEqual([
      { kind: "promote", text: "Promotes to Legendary" },
      { kind: "relegate", text: "Drops to Uncommon 1" },
    ]);
  });

  test("top division overall: no above name even if promote were somehow true -> falls back", () => {
    // Defensive case -- the page never sets promote=true without an `above`
    // once a division isn't first-overall, but the helper stays safe either way.
    const input: ZoneKeyLinesInput = { promote: true, relegate: false, above: undefined };
    expect(zoneKeyLines(input)[0]!.text).toBe("Promotes");
  });
});
