import { describe, it, expect } from "vitest";
import { lineDecisions, type LineRow } from "./lives-line-core";

const row = (id: string, tied = false, netLives = 0): LineRow => ({ playerId: id, displayName: id.toUpperCase(), tiedWithPrev: tied, netLives });

describe("lineDecisions", () => {
  it("reports a promotion line decided by lives and ignores a mid-table tie", () => {
    const chain = [row("a"), row("b", true), row("c"), row("d", true), row("e")];
    const lives = [row("b", false, 4), row("a", false, 1), row("c", false, 2), row("d", false, 2), row("e")];
    expect(lineDecisions(chain, lives, 1, 1)).toEqual(["Promotion: B (+4) over A (+1)"]);
  });
  it("reports a relegation line and a still-tied line", () => {
    const chain = [row("a"), row("b"), row("c"), row("d", true)];
    const lives = [row("a"), row("b"), row("c", false, -1), row("d", false, -1)];
    const livesTied = [row("a"), row("b"), row("c", false, -1), row("d", true, -1)];
    expect(lineDecisions(chain, lives, 1, 1)).toEqual(["Relegation: D (-1) down instead of C (-1)"]);
    expect(lineDecisions(chain, livesTied, 1, 1)).toEqual(["Relegation line still tied on lives: C (-1), D (-1)"]);
  });
  it("returns nothing when no tie touches a line", () => {
    const chain = [row("a"), row("b"), row("c", true), row("d")];
    const lives = [row("a"), row("c", false, 3), row("b", false, 0), row("d")];
    expect(lineDecisions(chain, lives, 1, 1)).toEqual([]);
  });
});
