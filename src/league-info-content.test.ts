import { describe, it, expect } from "vitest";
import { buildStaticIntro } from "./league-info-content.js";
import { tiesText } from "./ties-text.js";

describe("buildStaticIntro", () => {
  it("embeds the lives-mode ties rule verbatim from tiesText", () => {
    expect(buildStaticIntro("lives")).toContain(tiesText("lives").rule);
  });

  it("embeds the chain-mode ties rule verbatim from tiesText", () => {
    expect(buildStaticIntro("chain")).toContain(tiesText("chain").rule);
  });

  it("points at the My standings button instead of a slash command", () => {
    const text = buildStaticIntro("chain");
    expect(text).toContain("**My standings**");
    expect(text).not.toContain("`/standings`");
  });

  it("says the bot runs the bans and picks, not 'facilitates the pick/ban phase'", () => {
    expect(buildStaticIntro("chain")).toContain("runs the bans and picks");
  });
});
