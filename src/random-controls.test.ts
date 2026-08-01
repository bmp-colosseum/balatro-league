import { describe, it, expect } from "vitest";
import { randomControlsRow } from "./random-controls.js";

describe("randomControlsRow -- quick-roll button bar", () => {
  it("has exactly the four random: buttons, in order", () => {
    const row = randomControlsRow();
    const buttons = row.components.map((b) => b.toJSON());
    expect(buttons.map((b) => ("custom_id" in b ? b.custom_id : undefined))).toEqual([
      "random:deck",
      "random:stake",
      "random:combo",
      "random:bans",
    ]);
  });

  it("labels every button for a human, not just a customId", () => {
    const row = randomControlsRow();
    const labels = row.components.map((b) => b.toJSON()).map((b) => ("label" in b ? b.label : undefined));
    expect(labels).toEqual(["Random Deck", "Random Stake", "Random Combo", "Random Bans"]);
  });
});
