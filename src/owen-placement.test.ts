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

describe("buildOwenPlacement — the floor (minimal rank)", () => {
  it("overflow drops a rookie, never relegates a returner", () => {
    // Rare 2 (index 2): 4 mid-standing returners (no promotion) + 1 rookie that
    // lands here by MMR. target 4 → must shed one. The ROOKIE drops to Common;
    // every returner keeps their division.
    const returners = [
      returner("ret1", 2, 4, 10, 1000),
      returner("ret2", 2, 5, 10, 900),
      returner("ret3", 2, 6, 10, 800),
      returner("ret4", 2, 7, 10, 700),
    ];
    const rookies: RookieInput[] = [{ discordId: "rook", displayName: "rook", mmr: 850 }];
    const out = buildOwenPlacement(DIVS, returners, rookies, 4);
    const rare2 = out[2]!.members;
    // Floor: all four returners keep their division; the rookie is the one that
    // moved (wherever the open space was).
    expect(rare2.map((m) => m.discordId).sort()).toEqual(["ret1", "ret2", "ret3", "ret4"]);
    expect(rare2.filter((m) => m.isRookie)).toHaveLength(0);
    expect(out.flatMap((d) => d.members.map((m) => m.discordId))).toContain("rook");
  });
});

describe("buildOwenPlacement — overflow balances rookies, locks returners", () => {
  it("moves only rookies; returners keep their division", () => {
    const returners = [
      returner("ret1", 1, 4, 8, 1500),
      returner("ret2", 1, 5, 8, 1400),
      returner("ret3", 1, 6, 8, 1300),
    ];
    const rookies: RookieInput[] = Array.from({ length: 6 }, (_, i) => ({ discordId: `k${i}`, displayName: `k${i}`, mmr: 1400 }));
    const out = buildOwenPlacement(DIVS, returners, rookies, 3);
    expect(out[1]!.members.filter((m) => !m.isRookie).map((m) => m.discordId).sort()).toEqual(["ret1", "ret2", "ret3"]);
    expect(out[1]!.members.filter((m) => m.isRookie)).toHaveLength(0);
    expect(out.reduce((a, d) => a + d.members.length, 0)).toBe(9);
  });

  it("leaves a returner-only division over target rather than moving a finisher", () => {
    // Mid-ranks in a size-10 division → no promotion/relegation. With no rookies
    // and target 2, the balancer leaves all 5 put rather than bumping a finisher.
    const returners = Array.from({ length: 5 }, (_, i) => returner(`r-${i}`, 2, i + 3, 10));
    const out = buildOwenPlacement(DIVS, returners, [], 2);
    expect(out[2]!.members).toHaveLength(5);
  });
});

describe("buildOwenPlacement — fixed top division (Legendary)", () => {
  it("caps the top division at topTarget, overflowing rookies down", () => {
    // 2 returners hold Legendary; 5 high-MMR rookies all GLB into Legendary
    // (avg 1950 ≤ 2100). topTarget 3 → Legendary keeps 2 returners + 1 rookie;
    // the other 4 rookies overflow down.
    const returners = [returner("leg1", 0, 5, 10, 2000), returner("leg2", 0, 6, 10, 1900)];
    const rookies: RookieInput[] = Array.from({ length: 5 }, (_, i) => ({ discordId: `k${i}`, displayName: `k${i}`, mmr: 2100 }));
    const out = buildOwenPlacement(DIVS, returners, rookies, 3, 3);
    expect(out[0]!.members.length).toBeLessThanOrEqual(3);
    // Both returners keep Legendary (locked).
    expect(out[0]!.members.filter((m) => !m.isRookie).map((m) => m.discordId).sort()).toEqual(["leg1", "leg2"]);
  });
});
