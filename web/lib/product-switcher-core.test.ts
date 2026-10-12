import { describe, expect, it } from "vitest";
import { productSwitcherRows } from "./product-switcher-core";

describe("productSwitcherRows", () => {
  it("always returns League then Tour, in that order", () => {
    const rows = productSwitcherRows("Season 9");
    expect(rows.map((r) => r.key)).toEqual(["league", "tour"]);
  });

  it("League row points at the root domain and is always marked current (this app IS the League)", () => {
    const [league] = productSwitcherRows(null);
    expect(league.href).toBe("https://balatroleague.com");
    expect(league.current).toBe(true);
  });

  it("Tour row points at the Tour subdomain and is never marked current", () => {
    const [, tour] = productSwitcherRows("Season 9");
    expect(tour.href).toBe("https://tour.balatroleague.com");
    expect(tour.current).toBe(false);
  });

  it("League row's subtitle names the active season when one is given", () => {
    const [league] = productSwitcherRows("Season 9");
    expect(league.sub).toBe("Now viewing Season 9");
  });

  it("League row falls back to a generic subtitle with no active season", () => {
    const [league] = productSwitcherRows(null);
    expect(league.sub).toBe("Standings, divisions and seasons");
  });

  it("never fabricates a Tour-side live stat (this app has no access to the Tour's own data)", () => {
    const [, tour] = productSwitcherRows("Season 9");
    expect(tour.sub).not.toMatch(/\d/);
  });
});
