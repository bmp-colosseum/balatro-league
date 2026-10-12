import { describe, it, expect } from "vitest";
import { tiesText } from "./ties-text.js";

describe("tiesText", () => {
  it("lives mode: states shootout, then 2-0 head-to-head, then head-to-head lives, then net lives, then real tie for 3+", () => {
    const { rule } = tiesText("lives");
    const shootoutIdx = rule.indexOf("shootout");
    const h2hIdx = rule.indexOf("head-to-head 2-0");
    const h2hLivesIdx = rule.indexOf("the lives from that match");
    const netLivesIdx = rule.indexOf("total net lives for the season");
    const threeOrMoreIdx = rule.indexOf("Three or more tied");
    expect(shootoutIdx).toBeGreaterThanOrEqual(0);
    expect(h2hIdx).toBeGreaterThan(shootoutIdx);
    expect(h2hLivesIdx).toBeGreaterThan(h2hIdx);
    expect(netLivesIdx).toBeGreaterThan(h2hLivesIdx);
    expect(threeOrMoreIdx).toBeGreaterThan(netLivesIdx);
  });

  it("lives mode: defines net lives", () => {
    expect(tiesText("lives").rule).toContain(
      "Net lives = the lives you had left in your wins, minus the lives your opponents had left in your losses.",
    );
  });

  it("chain mode: head-to-head 2-0 first, shootout as the fallback", () => {
    const { rule } = tiesText("chain");
    const h2hIdx = rule.indexOf("head-to-head 2-0");
    const shootoutIdx = rule.indexOf("shootout");
    expect(h2hIdx).toBeGreaterThanOrEqual(0);
    expect(shootoutIdx).toBeGreaterThan(h2hIdx);
  });

  it("chain mode never mentions net lives (not part of this mode's order)", () => {
    expect(tiesText("chain").rule).not.toContain("net lives");
  });

  it("shootout is optional under lives, mandatory-flavored under chain", () => {
    expect(tiesText("lives").shootoutCallToAction).toContain("optional");
    expect(tiesText("chain").shootoutCallToAction).not.toContain("optional");
  });

  it("unresolved-reason differs by mode", () => {
    expect(tiesText("lives").shootoutUnresolvedReason).toBe("and net lives didn't settle it either");
    expect(tiesText("chain").shootoutUnresolvedReason).toBe("and your head-to-head didn't settle it");
  });
});
