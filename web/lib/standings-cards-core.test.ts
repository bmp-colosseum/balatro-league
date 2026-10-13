import { describe, expect, test } from "vitest";
import {
  divisionSummaryLine,
  groupTiebreakNotes,
  initials,
  recordPips,
  tiebreakDecidedPhrase,
  type RecordPipKind,
  type TiebreakDecidedKind,
  type TiebreakNoteRow,
  type TiebreakWordingValues,
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
    expect(groupTiebreakNotes(rows, true)).toEqual([]);
  });

  test("3-way group, all with net lives -> one merged footnote naming everyone, lives in row order", () => {
    const rows = [
      row("Birb", 6, "Tied on points with Frankdeslimste and Mangoman007; total net lives decided it (-4 / -5 / -7)", -4),
      row("Frankdeslimste", 6, "Tied on points with Birb and Mangoman007; total net lives decided it (-4 / -5 / -7)", -5),
      row("Mangoman007", 6, "Tied on points with Birb and Frankdeslimste; total net lives decided it (-4 / -5 / -7)", -7),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
      {
        lastIndex: 2,
        text: "Birb, Frankdeslimste and Mangoman007 tied on points: total net lives decided it (-4 / -5 / -7)",
      },
    ]);
  });

  test("2-way group without net lives (e.g. shootout-decided) -> falls back to a plain tied-on-points line", () => {
    const rows = [
      row("Ann", 9, "Tied on points with Lee; shootout decided it"),
      row("Lee", 9, "Tied on points with Ann; shootout decided it"),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
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
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points: total net lives decided it (3 / 1)" },
      { lastIndex: 3, text: "Cara and Dev tied on points: total net lives decided it (2 / 0)" },
    ]);
  });

  test("a group where only some rows carry net lives -> falls back (no partial lives list)", () => {
    const rows = [
      row("Ann", 9, "Tied with Lee on points and net lives -- shares the place", 3),
      row("Lee", 9, "Tied with Ann on points and net lives -- shares the place"),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
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
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 2, text: "Ann and Lee tied on points" },
    ]);
  });

  test("every tied player's net lives are 0 (nothing played yet) -> suppressed entirely", () => {
    const rows = [
      row("baconisbets", 0, "Tied on points with everyone; total net lives decided it (0 / 0 / 0 / 0 / 0)", 0),
      row("ezhikgoobikov", 0, "Tied on points with everyone; total net lives decided it (0 / 0 / 0 / 0 / 0)", 0),
      row("Jellyy", 0, "Tied on points with everyone; total net lives decided it (0 / 0 / 0 / 0 / 0)", 0),
      row("Owen", 0, "Tied on points with everyone; total net lives decided it (0 / 0 / 0 / 0 / 0)", 0),
      row("piton322", 0, "Tied on points with everyone; total net lives decided it (0 / 0 / 0 / 0 / 0)", 0),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([]);
  });

  test("some net lives 0 but not all -> still reported (a real tie, not a no-matches artifact)", () => {
    const rows = [
      row("Ann", 6, "Tied on points with Lee; total net lives decided it (0 / -2)", 0),
      row("Lee", 6, "Tied on points with Ann; total net lives decided it (0 / -2)", -2),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points: total net lives decided it (0 / -2)" },
    ]);
  });

  test("zero-lives group sitting between two normal groups -> only the zero one is dropped", () => {
    const rows = [
      row("Ann", 9, "Tied on points with Lee; total net lives decided it (3 / 1)", 3),
      row("Lee", 9, "Tied on points with Ann; total net lives decided it (3 / 1)", 1),
      row("Cara", 6, "Tied on points with Dev; total net lives decided it (0 / 0)", 0),
      row("Dev", 6, "Tied on points with Cara; total net lives decided it (0 / 0)", 0),
      row("Fin", 3, "Tied on points with Gus; total net lives decided it (-1 / -3)", -1),
      row("Gus", 3, "Tied on points with Fin; total net lives decided it (-1 / -3)", -3),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points: total net lives decided it (3 / 1)" },
      { lastIndex: 5, text: "Fin and Gus tied on points: total net lives decided it (-1 / -3)" },
    ]);
  });

  // --- kind-aware wording (tiebreakKind/tiebreakValues set -- the real
  // pipeline's shape once lib/standings.ts and the cache both thread them
  // through) ---------------------------------------------------------------
  function kindRow(
    name: string,
    points: number,
    tiebreakNote: string,
    tiebreakKind: TiebreakNoteRow["tiebreakKind"],
    opts: { netLives?: number; tiebreakValues?: TiebreakWordingValues; clinched?: boolean } = {},
  ): TiebreakNoteRow {
    return { points, tiebreakNote, tiebreakKind, player: { displayName: name }, ...opts };
  }

  test("shootout kind, final -> shootout decided it", () => {
    const rows = [
      kindRow("Ann", 9, "...", "shootout", { netLives: 1 }),
      kindRow("Lee", 9, "...", "shootout", { netLives: -1 }),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points: shootout decided it" },
    ]);
  });

  test("shootout kind, not final -> present-tense, no clinch -> currently separates them", () => {
    const rows = [
      kindRow("Ann", 9, "...", "shootout", { netLives: 1 }),
      kindRow("Lee", 9, "...", "shootout", { netLives: -1 }),
    ];
    expect(groupTiebreakNotes(rows, false)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points; a shootout currently separates them" },
    ]);
  });

  test("headToHeadResult kind, final", () => {
    const rows = [
      kindRow("Ann", 9, "...", "headToHeadResult", { netLives: 1, tiebreakValues: { won: true } }),
      kindRow("Lee", 9, "...", "headToHeadResult", { netLives: -1, tiebreakValues: { won: false } }),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points: beat them head-to-head" },
    ]);
  });

  test("headToHeadResult kind, not final -> present-tense from the first row's perspective", () => {
    const rows = [
      kindRow("Ann", 9, "...", "headToHeadResult", { netLives: 1, tiebreakValues: { won: true } }),
      kindRow("Lee", 9, "...", "headToHeadResult", { netLives: -1, tiebreakValues: { won: false } }),
    ];
    expect(groupTiebreakNotes(rows, false)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points; is currently ahead of them head-to-head" },
    ]);
  });

  test("headToHeadLives kind, final", () => {
    const rows = [
      kindRow("Ann", 9, "...", "headToHeadLives", { netLives: 1, tiebreakValues: { diff: 3 } }),
      kindRow("Lee", 9, "...", "headToHeadLives", { netLives: -1, tiebreakValues: { diff: -3 } }),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points: head-to-head lives +3 vs -3 decided it" },
    ]);
  });

  test("headToHeadLives kind, not final", () => {
    const rows = [
      kindRow("Ann", 9, "...", "headToHeadLives", { netLives: 1, tiebreakValues: { diff: 3 } }),
      kindRow("Lee", 9, "...", "headToHeadLives", { netLives: -1, tiebreakValues: { diff: -3 } }),
    ];
    expect(groupTiebreakNotes(rows, false)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points; head-to-head lives +3 vs -3 currently separate them" },
    ]);
  });

  test("netLives kind, final -> matches the legacy wording byte-for-byte", () => {
    const rows = [
      kindRow("piton322", 6, "...", "netLives", { netLives: 3 }),
      kindRow("ezhikgoobikov", 6, "...", "netLives", { netLives: -3 }),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 1, text: "piton322 and ezhikgoobikov tied on points: total net lives decided it (3 / -3)" },
    ]);
  });

  test("netLives kind, not final -> present-tense wording with the team's exact example punctuation", () => {
    const rows = [
      kindRow("piton322", 6, "...", "netLives", { netLives: 3 }),
      kindRow("ezhikgoobikov", 6, "...", "netLives", { netLives: -3 }),
    ];
    expect(groupTiebreakNotes(rows, false)).toEqual([
      { lastIndex: 1, text: "piton322 and ezhikgoobikov tied on points; net lives currently separate them (3 / -3)" },
    ]);
  });

  test("realTie kind never takes \"decided it\" wording, final or not", () => {
    const rows = [
      kindRow("Ann", 9, "...", "realTie", { netLives: 2 }),
      kindRow("Lee", 9, "...", "realTie", { netLives: 2 }),
    ];
    const expected = [{ lastIndex: 1, text: "Ann and Lee tied on points and net lives -- shares the place" }];
    expect(groupTiebreakNotes(rows, true)).toEqual(expected);
    expect(groupTiebreakNotes(rows, false)).toEqual(expected);
  });

  test("a group where every member is individually clinched counts as final even when the division isn't complete", () => {
    const rows = [
      kindRow("Ann", 9, "...", "netLives", { netLives: 3, clinched: true }),
      kindRow("Lee", 9, "...", "netLives", { netLives: -3, clinched: true }),
    ];
    expect(groupTiebreakNotes(rows, false)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points: total net lives decided it (3 / -3)" },
    ]);
  });

  test("a group where only SOME members are clinched is NOT final", () => {
    const rows = [
      kindRow("Ann", 9, "...", "netLives", { netLives: 3, clinched: true }),
      kindRow("Lee", 9, "...", "netLives", { netLives: -3, clinched: false }),
    ];
    expect(groupTiebreakNotes(rows, false)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points; net lives currently separate them (3 / -3)" },
    ]);
  });

  test("members disagreeing on tiebreakKind -> falls back to legacy kind-blind wording", () => {
    const rows = [
      kindRow("Ann", 9, "...", "netLives", { netLives: 3 }),
      kindRow("Lee", 9, "...", "shootout", { netLives: -3 }),
    ];
    expect(groupTiebreakNotes(rows, true)).toEqual([
      { lastIndex: 1, text: "Ann and Lee tied on points: total net lives decided it (3 / -3)" },
    ]);
  });

  test("3-way netLives group, not final -> one shared list, present tense", () => {
    const rows = [
      kindRow("Birb", 6, "...", "netLives", { netLives: -4 }),
      kindRow("Frankdeslimste", 6, "...", "netLives", { netLives: -5 }),
      kindRow("Mangoman007", 6, "...", "netLives", { netLives: -7 }),
    ];
    expect(groupTiebreakNotes(rows, false)).toEqual([
      {
        lastIndex: 2,
        text: "Birb, Frankdeslimste and Mangoman007 tied on points; net lives currently separate them (-4 / -5 / -7)",
      },
    ]);
  });
});

describe("tiebreakDecidedPhrase", () => {
  test.each<[string, TiebreakDecidedKind, TiebreakWordingValues, boolean, string]>([
    ["shootout, final", "shootout", {}, true, "shootout decided it"],
    ["shootout, not final", "shootout", {}, false, "a shootout currently separates them"],
    ["head-to-head result, won, final", "headToHeadResult", { won: true }, true, "beat them head-to-head"],
    ["head-to-head result, lost, final", "headToHeadResult", { won: false }, true, "lost to them head-to-head"],
    [
      "head-to-head result, won, not final",
      "headToHeadResult",
      { won: true },
      false,
      "is currently ahead of them head-to-head",
    ],
    [
      "head-to-head result, lost, not final",
      "headToHeadResult",
      { won: false },
      false,
      "is currently behind them head-to-head",
    ],
    [
      "head-to-head lives, positive diff, final",
      "headToHeadLives",
      { diff: 3 },
      true,
      "head-to-head lives +3 vs -3 decided it",
    ],
    [
      "head-to-head lives, negative diff, final",
      "headToHeadLives",
      { diff: -2 },
      true,
      "head-to-head lives -2 vs +2 decided it",
    ],
    [
      "head-to-head lives, not final",
      "headToHeadLives",
      { diff: 3 },
      false,
      "head-to-head lives +3 vs -3 currently separate them",
    ],
    [
      "net lives, final",
      "netLives",
      { livesList: [3, -3] },
      true,
      "total net lives decided it (3 / -3)",
    ],
    [
      "net lives, not final",
      "netLives",
      { livesList: [3, -3] },
      false,
      "net lives currently separate them (3 / -3)",
    ],
    [
      "net lives, 3-way list, final",
      "netLives",
      { livesList: [-4, -5, -7] },
      true,
      "total net lives decided it (-4 / -5 / -7)",
    ],
  ])("%s", (_name, kind, values, isFinal, expected) => {
    expect(tiebreakDecidedPhrase(kind, values, isFinal)).toBe(expected);
  });
});

describe("divisionSummaryLine", () => {
  test("no matches played -> none played, regardless of leader", () => {
    expect(divisionSummaryLine({ playedMatches: 0, expectedMatches: 10 })).toBe("none played");
  });

  test("no leader name available -> none played fallback", () => {
    expect(divisionSummaryLine({ playedMatches: 4, expectedMatches: 10 })).toBe("none played");
  });

  test("matches played with a leader -> leader + progress line", () => {
    expect(
      divisionSummaryLine({ leaderName: "Birb", playedMatches: 4, expectedMatches: 10 }),
    ).toBe("Birb leads . 4/10");
  });

  test("leader name with different progress counts", () => {
    expect(
      divisionSummaryLine({ leaderName: "Zed", playedMatches: 1, expectedMatches: 6 }),
    ).toBe("Zed leads . 1/6");
  });
});

describe("groupTiebreakNotes mixed-kind fallback follows isFinal", () => {
  function mk(name: string, netLives: number, kind: "realTie" | "netLives"): TiebreakNoteRow {
    return { points: 3, tiebreakNote: "tied", netLives, tiebreakKind: kind, player: { displayName: name } } as TiebreakNoteRow;
  }
  const rows = [mk("A", 0, "realTie"), mk("B", 0, "realTie"), mk("C", 0, "realTie"), mk("D", -8, "netLives")];
  test("uses present-tense wording while the division is still live", () => {
    const text = groupTiebreakNotes(rows, false)[0]?.text ?? "";
    expect(text).toContain("net lives currently separate them (0 / 0 / 0 / -8)");
    expect(text).not.toContain("decided it");
  });
  test("uses decided-it wording once the division is complete", () => {
    expect(groupTiebreakNotes(rows, true)[0]?.text ?? "").toContain("total net lives decided it (0 / 0 / 0 / -8)");
  });
});
