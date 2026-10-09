import { describe, expect, test } from "vitest";
import {
  divisionSummaryLine,
  groupTiebreakNotes,
  initials,
  recordPips,
  type RecordPipKind,
  type TiebreakNoteRow,
} from "./standings-cards-core";

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

describe("groupTiebreakNotes", () => {
  function row(name: string, points: number, tiebreakNote?: string, netLives?: number): TiebreakNoteRow {
    return { points, tiebreakNote, netLives, player: { displayName: name } };
  }

  test("no tiebreak notes -> no groups", () => {
    const rows = [row("Alice", 9), row("Bob", 6), row("Cara", 3)];
    expect(groupTiebreakNotes(rows)).toEqual([]);
  });

  test("3-way group, all with net lives -> one merged footnote naming everyone, lives in row order", () => {
    const rows = [
      row("Birb", 6, "Tied on points with Frankdeslimste and Mangoman007; total net lives decided it (-4 / -5 / -7)", -4),
      row("Frankdeslimste", 6, "Tied on points with Birb and Mangoman007; total net lives decided it (-4 / -5 / -7)", -5),
      row("Mangoman007", 6, "Tied on points with Birb and Frankdeslimste; total net lives decided it (-4 / -5 / -7)", -7),
    ];
    expect(groupTiebreakNotes(rows)).toEqual([
      {
        lastIndex: 2,
        text: "Birb, Frankdeslimste and Mangoman007 tied on points -- total net lives decided it (-4 / -5 / -7)",
      },
    ]);
  });

  test("2-way group without net lives (e.g. shootout-decided) -> falls back to a plain tied-on-points line", () => {
    const rows = [
      row("Ann", 9, "Tied on points with Lee; shootout decided it"),
      row("Lee", 9, "Tied on points with Ann; shootout decided it"),
    ];
    expect(groupTiebreakNotes(rows)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points" },
    ]);
  });

  test("two separate adjacent groups with different points -> two groups, not merged", () => {
    const rows = [
      row("Ann", 9, "Tied on points with Lee; total net lives decided it (3 / 1)", 3),
      row("Lee", 9, "Tied on points with Ann; total net lives decided it (3 / 1)", 1),
      row("Cara", 6, "Tied on points with Dev; total net lives decided it (2 / 0)", 2),
      row("Dev", 6, "Tied on points with Cara; total net lives decided it (2 / 0)", 0),
    ];
    expect(groupTiebreakNotes(rows)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points -- total net lives decided it (3 / 1)" },
      { lastIndex: 3, text: "Cara and Dev tied on points -- total net lives decided it (2 / 0)" },
    ]);
  });

  test("a group where only some rows carry net lives -> falls back (no partial lives list)", () => {
    const rows = [
      row("Ann", 9, "Tied with Lee on points and net lives -- shares the place", 3),
      row("Lee", 9, "Tied with Ann on points and net lives -- shares the place"),
    ];
    expect(groupTiebreakNotes(rows)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points" },
    ]);
  });

  test("untied rows around a tie group are left out of any group", () => {
    const rows = [
      row("Leader", 12),
      row("Ann", 9, "Tied on points with Lee; shootout decided it"),
      row("Lee", 9, "Tied on points with Ann; shootout decided it"),
      row("Last", 3),
    ];
    expect(groupTiebreakNotes(rows)).toEqual([
      { lastIndex: 2, text: "Ann and Lee tied on points" },
    ]);
  });
});

describe("divisionSummaryLine", () => {
  test("no matches played -> no matches yet, regardless of leader", () => {
    expect(
      divisionSummaryLine({ divisionName: "Rare 2", playedMatches: 0, expectedMatches: 10 }),
    ).toBe("Rare 2 - no matches yet");
  });

  test("no leader name available -> no matches yet fallback", () => {
    expect(
      divisionSummaryLine({ divisionName: "Rare 2", playedMatches: 4, expectedMatches: 10 }),
    ).toBe("Rare 2 - no matches yet");
  });

  test("matches played with a leader -> full summary line", () => {
    expect(
      divisionSummaryLine({
        divisionName: "Rare 2",
        leaderName: "Birb",
        leaderPoints: 9,
        playedMatches: 4,
        expectedMatches: 10,
      }),
    ).toBe("Rare 2 - leader Birb 9 pts - 4/10 played");
  });

  test("leaderPoints missing defaults to 0", () => {
    expect(
      divisionSummaryLine({
        divisionName: "Common 1",
        leaderName: "Zed",
        playedMatches: 1,
        expectedMatches: 6,
      }),
    ).toBe("Common 1 - leader Zed 0 pts - 1/6 played");
  });

  test("a single point reads pt, not pts", () => {
    expect(
      divisionSummaryLine({
        divisionName: "Uncommon 4",
        leaderName: "andrejweb3",
        leaderPoints: 1,
        playedMatches: 1,
        expectedMatches: 14,
      }),
    ).toBe("Uncommon 4 - leader andrejweb3 1 pt - 1/14 played");
  });
});
