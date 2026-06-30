import { describe, it, expect } from "vitest";
import { buildOwenPlacement, divisionMovement, type ReturnerInput, type RookieInput } from "./owen-placement.js";

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

  it("Rare 1 ↔ Rare 2 is ALWAYS 1/1 — even when both are big (Rare 1 is outside the 2-swap)", () => {
    // 8 in each (≥ threshold), so the size rule WOULD say 2 — but Rare 1 is
    // excluded, so only its single bottom finisher relegates and only Rare 2's
    // top one promotes. A Rare 1 player who isn't dead last never drops.
    const rare1 = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => returner(`r1-${r}`, 1, r, 1800));
    const rare2 = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => returner(`r2-${r}`, 2, r, 1600));
    const out = buildOwenPlacement(DIVS, [...rare1, ...rare2], [], 100);
    expect(idsIn(out, 2)).toContain("r1-8"); // only the bottom one relegates
    expect(idsIn(out, 2)).not.toContain("r1-7"); // 2nd-from-bottom STAYS in Rare 1
    expect(idsIn(out, 1)).toContain("r2-1"); // only Rare 2's top promotes
    expect(idsIn(out, 1)).not.toContain("r2-2"); // 2nd does NOT
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

  it("honors a configured threshold + big swap (≥6 → swap 3)", () => {
    const rare4 = Array.from({ length: 6 }, (_, i) => returner(`r4-${i + 1}`, 4, i + 1, 900));
    const unc1 = Array.from({ length: 6 }, (_, i) => returner(`u1-${i + 1}`, 5, i + 1, 700));
    const out = buildOwenPlacement(DIVS, [...rare4, ...unc1], [], 100, { swapThreshold: 6, bigSwap: 3 });
    // Both 6 ≥ threshold 6 → 3 swap: Unc 1's top 3 promote, Rare 4's bottom 3 relegate.
    expect(idsIn(out, 4)).toEqual(expect.arrayContaining(["u1-1", "u1-2", "u1-3"]));
    expect(idsIn(out, 5)).toEqual(expect.arrayContaining(["r4-4", "r4-5", "r4-6"]));
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

describe("buildOwenPlacement — top division is never auto-trimmed", () => {
  it("leaves Legendary OVER the cap rather than dropping anyone", () => {
    // 8 Legendary finishers, nothing in Rare 1 to backfill → the 1-down boundary
    // relegates exactly ONE (the bottom), leaving 7. Even though topTarget is 6,
    // NOBODY is dropped to hit the cap — Legendary is left over-size at 7.
    const leg = Array.from({ length: 8 }, (_, i) => returner(`leg${i + 1}`, 0, i + 1, 2000 - i * 10));
    const out = buildOwenPlacement(DIVS, leg, [], 100, { topTarget: 6 });
    expect(out[0]!.members).toHaveLength(7); // 8 − 1 relegated; left over the cap, not trimmed
    expect(out[1]!.members.map((m) => m.discordId)).toContain("leg8"); // only the bottom finisher relegated
  });
});

describe("divisionMovement — per-division promote/relegate (display = reality)", () => {
  // The simplified launch rule: tighten off, flat 2-up/2-down, Legendary 1/1.
  const RULES = { tightenTopTiers: false, swapThreshold: 8, baseSwap: 2, bigSwap: 2 };
  const sizes = DIVS.map(() => 10); // sizes irrelevant when baseSwap === bigSwap

  it("Legendary ↓1, Rare 1 ↑1/↓1 (outside the 2-swap), everywhere else ↑2/↓2, bottom ↓0", () => {
    const m = divisionMovement(DIVS, sizes, RULES);
    expect(m[0]).toEqual({ promote: 0, relegate: 1 }); // Legendary (top)
    expect(m[1]).toEqual({ promote: 1, relegate: 1 }); // Rare 1 — 1 up (Leg) / 1 down (Rare 2)
    expect(m[2]).toEqual({ promote: 1, relegate: 2 }); // Rare 2 — 1 up (matches Rare 1's 1 down) / 2 down
    expect(m[3]).toEqual({ promote: 2, relegate: 2 }); // Rare 3
    expect(m[5]).toEqual({ promote: 2, relegate: 2 }); // Uncommon 1
    expect(m[6]).toEqual({ promote: 2, relegate: 0 }); // Uncommon 2 (bottom)
  });

  it("matches what buildOwenPlacement actually does (no drift)", () => {
    // Rare 1 is outside the 2-swap, so even with 8 each it relegates exactly 1
    // (→ Rare 2) and Rare 2 promotes exactly 1 back up — matched at 1.
    const rare1 = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => returner(`r1-${r}`, 1, r, 1800));
    const rare2 = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => returner(`r2-${r}`, 2, r, 1600));
    const out = buildOwenPlacement(DIVS, [...rare1, ...rare2], [], 100, RULES);
    const movedDownFromRare1 = rare1.filter((r) => divisionOf(out, r.discordId) === 2).length;
    const movedUpFromRare2 = rare2.filter((r) => divisionOf(out, r.discordId) === 1).length;
    expect(movedDownFromRare1).toBe(1);
    expect(movedUpFromRare2).toBe(1);
  });
});
