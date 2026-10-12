import { describe, it, expect } from "vitest";
import { buildPlayerHelpEmbed } from "./help.js";

describe("buildPlayerHelpEmbed", () => {
  it("titles itself 'How to play', not a slash-command list", () => {
    expect(buildPlayerHelpEmbed().data.title).toBe("How to play");
  });

  it("names every real button (Who do I play?, Start a match, My standings, League standings, Schedule with Hammertime)", () => {
    const text = buildPlayerHelpEmbed().data.description ?? "";
    for (const label of ["Who do I play?", "Start a match", "My standings", "League standings", "Schedule with Hammertime"]) {
      expect(text).toContain(label);
    }
  });

  it("points mid-match and result problems at the real buttons, not a slash command", () => {
    const text = buildPlayerHelpEmbed().data.description ?? "";
    expect(text).toContain("Call helper");
    expect(text).toContain("Report a problem");
    expect(text).not.toMatch(/`\/[a-z-]+/);
  });

  it("links the public how-it-works page", () => {
    expect(buildPlayerHelpEmbed().data.description ?? "").toContain("how-it-works");
  });

  it("has no footer (the admin-help pointer was dropped)", () => {
    expect(buildPlayerHelpEmbed().data.footer).toBeUndefined();
  });
});
