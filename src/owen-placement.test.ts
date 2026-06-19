import { describe, it, expect } from "vitest";
import { buildOwenPlacement, type ReturnerInput, type RookieInput } from "./owen-placement.js";

// Deep ladder so we can exercise the top (custom) boundaries AND the count-based
// ones below Rare 3.
const DIVS = [
  { tierName: "Legendary", name: "Legendary" }, // 0
  { tierName: "Rare", name: "Rare 1" }, // 1
  { tierName: "Rare", name: "Rare 2" }, // 2
  { tierName: "Rare", name: "Rare 3" }, // 3
  { tierName: "Rare", name: "Rare 4" }, // 4
  { tierName: "Uncommon", name: "Uncommon 1" }, // 5
  { tierName: "Uncommon", name: "Uncommon 2" }, // 6
];

function returner(id: string, divIndex: number, standingRank: number, mmr = 1000): ReturnerInput {
  return { discordId: id, displayName: id, mmr, divIndex, standingRank, divSize: 10, standing: { rank: standingRank, record: "0-0-0" } };
}
const idsIn = (out: ReturnType<typeof buildOwenPlacement>, i: number) => out[i]!.members.map((m) => m.discordId);
const divisionOf = (out: ReturnType<typeof buildOwenPlacement>, id: string) =>
  out.findIndex((d) => d.members.some((m) => m.discordId === id));

describe("pairwise boundary promotion/relegation — top tiers", () => {
  it("Legendary ↔ Rare 1 swaps exactly 1 up / 1 down", () => {
    const leg = [1, 2, 3, 4, 5, 6].map((r) => returner(`leg${r}`, 0, r, 2000));
    const rare1 = [1, 2, 3, 4, 5, 6].map((r) => returner(`r1-${r}`, 1, r, 1800));
    const out = buildOwenPlacement(DIVS, [...leg, ...rare1], [], 100);
    // Rare 1's #1 promotes into Legendary; Legendary's last (leg6) relegates out.
    expect(idsIn(out, 0)).toContain("r1-1");
    expect(idsIn(out, 0)).not.toContain("leg6");
    expect(idsIn(out, 0)).toContain("leg1");
    expect(idsIn(out, 1)).toContain("leg6");
  });

  it("Rare 1 ↔ Rare 2 swaps 1 up / 2 down", () => {
    const rare1 = [1, 2, 3, 4, 5, 6].map((r) => returner(`r1-${r}`, 1, r, 1800));
    const rare2 = [1, 2, 3, 4, 5, 6].map((r) => returner(`r2-${r}`, 2, r, 1600));
    const out = buildOwenPlacement(DIVS, [...rare1, ...rare2], [], 100);
    // 2 relegated from Rare 1 (its bottom two) → Rare 2.
    expect(idsIn(out, 2)).toEqual(expect.arrayContaining(["r1-5", "r1-6"]));
    // 1 promoted from Rare 2 (its top) → Rare 1.
    expect(idsIn(out, 1)).toContain("r2-1");
  });
});

describe("pairwise boundary promotion/relegation — count-based tiers", () => {
  it("swaps 2 when BOTH divisions have ≥ 8 finishers", () => {
    const rare4 = Array.from({ length: 8 }, (_, i) => returner(`r4-${i + 1}`, 4, i + 1, 900));
    const unc1 = Array.from({ length: 8 }, (_, i) => returner(`u1-${i + 1}`, 5, i + 1, 700));
    const out = buildOwenPlacement(DIVS, [...rare4, ...unc1], [], 100);
    // Unc 1's top two promote to Rare 4; Rare 4's bottom two relegate to Unc 1.
    expect(idsIn(out, 4)).toEqual(expect.arrayContaining(["u1-1", "u1-2"]));
    expect(idsIn(out, 5)).toEqual(expect.arrayContaining(["r4-7", "r4-8"]));
  });

  it("swaps only 1 when a division has < 8 finishers", () => {
    const rare4 = Array.from({ length: 8 }, (_, i) => returner(`r4-${i + 1}`, 4, i + 1, 900));
    const unc1 = Array.from({ length: 7 }, (_, i) => returner(`u1-${i + 1}`, 5, i + 1, 700));
    const out = buildOwenPlacement(DIVS, [...rare4, ...unc1], [], 100);
    expect(idsIn(out, 4)).toContain("u1-1");
    expect(idsIn(out, 4)).not.toContain("u1-2"); // only one promoted
    expect(idsIn(out, 5)).toContain("r4-8"); // one relegated
    expect(idsIn(out, 5)).not.toContain("r4-7");
  });
});

describe("buildOwenPlacement — rookies", () => {
  it("places a stronger rookie in a higher division than a weaker one", () => {
    const returners = [
      ...Array.from({ length: 5 }, (_, i) => returner(`hi${i}`, 3, i + 1, 1000)),
      ...Array.from({ length: 5 }, (_, i) => returner(`lo${i}`, 6, i + 1, 400)),
    ];
    const rookies: RookieInput[] = [
      { discordId: "strong", displayName: "strong", mmr: 1200 },
      { discordId: "weak", displayName: "weak", mmr: 300 },
    ];
    const out = buildOwenPlacement(DIVS, returners, rookies, 100);
    expect(divisionOf(out, "strong")).toBeLessThan(divisionOf(out, "weak"));
  });
});

describe("buildOwenPlacement — fixed top division", () => {
  it("hard-caps Legendary at topTarget", () => {
    // 8 Legendary finishers, nothing in Rare 1 to backfill → after the 1-down
    // boundary it's 7, then the cap trims to 6.
    const leg = Array.from({ length: 8 }, (_, i) => returner(`leg${i + 1}`, 0, i + 1, 2000 - i * 10));
    const out = buildOwenPlacement(DIVS, leg, [], 100, 6);
    expect(out[0]!.members).toHaveLength(6);
  });
});
