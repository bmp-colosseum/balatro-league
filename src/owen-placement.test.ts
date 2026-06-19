import { describe, it, expect } from "vitest";
import { buildOwenPlacement, type ReturnerInput, type RookieInput } from "./owen-placement.js";

const DIVS = [
  { tierName: "Legendary", name: "Legendary" },
  { tierName: "Rare", name: "Rare 1" },
  { tierName: "Rare", name: "Rare 2" },
  { tierName: "Common", name: "Common 1" },
];

function returner(id: string, divIndex: number, standingRank: number, divSize: number, mmr = 1000): ReturnerInput {
  return { discordId: id, displayName: id, mmr, divIndex, standingRank, divSize, standing: { rank: standingRank, record: "0-0-0" } };
}

describe("buildOwenPlacement — promotion / relegation", () => {
  it("promotes the top finisher(s) of a division up one (K=2 when ≥8)", () => {
    const returners = Array.from({ length: 8 }, (_, i) => returner(`r1-${i}`, 1, i + 1, 8));
    const out = buildOwenPlacement(DIVS, returners, [], 100);
    const legendary = out[0]!.members.map((m) => m.discordId);
    expect(legendary).toContain("r1-0"); // rank 1
    expect(legendary).toContain("r1-1"); // rank 2
    expect(legendary).not.toContain("r1-2"); // rank 3 stays
  });

  it("relegates the bottom finisher(s) down one", () => {
    const returners = Array.from({ length: 8 }, (_, i) => returner(`r1-${i}`, 1, i + 1, 8));
    const out = buildOwenPlacement(DIVS, returners, [], 100);
    const rare2 = out[2]!.members.map((m) => m.discordId);
    expect(rare2).toContain("r1-7");
    expect(rare2).toContain("r1-6");
  });

  it("uses K=1 for small divisions (<8)", () => {
    const returners = Array.from({ length: 5 }, (_, i) => returner(`r1-${i}`, 1, i + 1, 5));
    const out = buildOwenPlacement(DIVS, returners, [], 100);
    expect(out[0]!.members.map((m) => m.discordId)).toEqual(["r1-0"]);
  });
});

describe("buildOwenPlacement — rookies + scale", () => {
  it("places rookies by MMR level, not all in the bottom", () => {
    // Mid-ranked in a size-10 division → no promotion/relegation, so the
    // division averages stay where we set them.
    const returners = [
      returner("leg", 0, 5, 10, 2000),
      returner("rare1", 1, 5, 10, 1500),
      returner("rare2", 2, 5, 10, 1000),
      returner("com", 3, 5, 10, 500),
    ];
    const rookies: RookieInput[] = [
      { discordId: "strong", displayName: "strong", mmr: 1600 },
      { discordId: "mid", displayName: "mid", mmr: 1100 },
      { discordId: "weak", displayName: "weak", mmr: 400 },
    ];
    const out = buildOwenPlacement(DIVS, returners, rookies, 100);
    expect(out[1]!.members.map((m) => m.discordId)).toContain("strong");
    expect(out[2]!.members.map((m) => m.discordId)).toContain("mid");
    expect(out[3]!.members.map((m) => m.discordId)).toContain("weak");
  });
});

describe("buildOwenPlacement — overflow", () => {
  it("rebalances so no division exceeds the target size", () => {
    const returners = Array.from({ length: 12 }, (_, i) => returner(`c-${i}`, 3, i + 1, 12, 2000 - i * 10));
    const out = buildOwenPlacement(DIVS, returners, [], 3);
    for (const d of out) expect(d.members.length).toBeLessThanOrEqual(3);
    expect(out.reduce((a, d) => a + d.members.length, 0)).toBe(12);
  });
});
