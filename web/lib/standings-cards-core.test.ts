import { describe, expect, test } from "vitest";
import { initials, recordPips, type RecordPipKind } from "./standings-cards-core";

describe("recordPips", () => {
  test.each<[string, [number, number, number], RecordPipKind[]]>([
    ["no results -> empty hand", [0, 0, 0], []],
    ["wins only", [3, 0, 0], ["win", "win", "win"]],
    ["draws only", [0, 2, 0], ["draw", "draw"]],
    ["losses only", [0, 0, 1], ["loss"]],
    [
      "mixed record -> wins, then draws, then losses",
      [2, 1, 3],
      ["win", "win", "draw", "loss", "loss", "loss"],
    ],
    [
      "negative counts floor to zero instead of throwing",
      [-1, 2, -5],
      ["draw", "draw"],
    ],
    [
      "non-integer counts truncate",
      [1.9, 0, 2.1],
      ["win", "loss", "loss"],
    ],
  ])("%s", (_name, [wins, draws, losses], expected) => {
    expect(recordPips(wins, draws, losses)).toEqual(expected);
  });

  test("total pip count always equals wins + draws + losses (after flooring)", () => {
    const wins = 4;
    const draws = 2;
    const losses = 5;
    expect(recordPips(wins, draws, losses)).toHaveLength(wins + draws + losses);
  });
});

describe("initials", () => {
  test.each<[string, string, string]>([
    ["two words -> first letter of each, uppercase", "Jamie Fox", "JF"],
    ["lowercase input -> uppercased", "jamie fox", "JF"],
    ["three+ words -> only the first two count", "Jamie Van Fox", "JV"],
    ["single word longer than 2 chars -> first 2 chars", "Jamie", "JA"],
    ["single word exactly 1 char -> that 1 char", "J", "J"],
    ["digits count as letters/digits", "Player1 Two2", "PT"],
    ["single word that starts with a digit", "99Problems", "99"],
    [
      "leading decorative symbol on a word -> stripped before extracting",
      "* Bob",
      "BO",
    ],
    ["extra whitespace between words is collapsed", "  Ann   Lee  ", "AL"],
    ["all-symbols name has no alnum content -> falls back to ?", "***", "?"],
    ["empty string -> falls back to ?", "", "?"],
  ])("%s", (_name, displayName, expected) => {
    expect(initials(displayName)).toBe(expected);
  });

  test("result is always at most 2 characters", () => {
    expect(initials("Supercalifragilisticexpialidocious").length).toBeLessThanOrEqual(2);
  });
});
