import { describe, expect, test } from "vitest";
import { boundaryBelow, zoneOf, type Zone, type ZoneExtras } from "./standings-zone";

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
