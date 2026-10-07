import { describe, it, expect } from "vitest";
import {
  buildUncounted,
  uncountedMatchKey,
  uncountedTag,
  type UncountedEntry,
} from "./uncounted-core.js";

describe("uncountedMatchKey", () => {
  it("is order-independent", () => {
    expect(uncountedMatchKey("a", "b")).toBe(uncountedMatchKey("b", "a"));
  });

  it("separates with | (not -, which cuids can themselves contain)", () => {
    expect(uncountedMatchKey("a-1", "b-2")).toBe("a-1|b-2");
  });
});

describe("uncountedTag", () => {
  const entries: UncountedEntry[] = [
    { matchKey: uncountedMatchKey("alice", "dropout1"), forPlayerId: "alice" },
    { matchKey: uncountedMatchKey("bob", "cara"), forPlayerId: "bob" },
  ];

  it.each([
    ["alice", "dropout1", "alice"],
    ["dropout1", "alice", "alice"], // order-independent on the match side
    ["bob", "cara", "bob"],
  ] as const)("uncountedTag(%p, %p) for %p -> the single tag", (playerAId, playerBId, forPlayerId) => {
    expect(uncountedTag(entries, playerAId, playerBId, forPlayerId)).toEqual({
      label: "not counted for standings",
      title: "This result isn't counted toward the standings under this season's scoring rule.",
    });
  });

  it("is null when nothing is set aside for this match", () => {
    expect(uncountedTag(entries, "alice", "someoneElse", "alice")).toBeNull();
  });

  it("is null for the OTHER side of a one-sided drop (bob's result vs cara can count for cara even though it's bob's worst)", () => {
    expect(uncountedTag(entries, "bob", "cara", "cara")).toBeNull();
  });

  it("is always null against an empty list (an \"all\"-mode season)", () => {
    expect(uncountedTag([], "alice", "bob", "alice")).toBeNull();
  });
});

describe("buildUncounted", () => {
  const members = [
    { playerId: "alice", status: "ACTIVE" as const },
    { playerId: "bob", status: "ACTIVE" as const },
    { playerId: "cara", status: "ACTIVE" as const },
    { playerId: "dave", status: "DROPPED" as const },
  ];

  it("count mode: tags a dropped result against the DROPPED member", () => {
    const rows = [
      { playerId: "alice", droppedResults: [{ opponentId: "dave" }] },
      { playerId: "bob", droppedResults: [] },
    ];
    const out = buildUncounted(members, rows, [], "count");
    expect(out).toEqual([
      { matchKey: uncountedMatchKey("alice", "dave"), forPlayerId: "alice" },
    ]);
  });

  it("count mode: tags a dropped result against a still-active member", () => {
    const rows = [{ playerId: "alice", droppedResults: [{ opponentId: "bob" }] }];
    const out = buildUncounted(members, rows, [], "count");
    expect(out).toEqual([
      { matchKey: uncountedMatchKey("alice", "bob"), forPlayerId: "alice" },
    ]);
  });

  it("void mode: every result against the dropout is tagged for the active side, even though it never appears in droppedResults", () => {
    const rows = [
      { playerId: "alice", droppedResults: [] },
      { playerId: "bob", droppedResults: [] },
      { playerId: "cara", droppedResults: [] },
    ];
    const pairings = [
      { playerAId: "alice", playerBId: "dave" }, // alice played the dropout
      { playerAId: "bob", playerBId: "cara" },   // not involving the dropout
    ];
    const out = buildUncounted(members, rows, pairings, "void");
    expect(out).toEqual([
      { matchKey: uncountedMatchKey("alice", "dave"), forPlayerId: "alice" },
    ]);
  });

  it("void mode: combines the voided-pairing entries with any other droppedResults", () => {
    const rows = [
      { playerId: "alice", droppedResults: [{ opponentId: "bob" }] }, // alice's worst, among survivors
    ];
    const pairings = [{ playerAId: "alice", playerBId: "dave" }];
    const out = buildUncounted(members, rows, pairings, "void");
    expect(out).toContainEqual({ matchKey: uncountedMatchKey("alice", "bob"), forPlayerId: "alice" });
    expect(out).toContainEqual({ matchKey: uncountedMatchKey("alice", "dave"), forPlayerId: "alice" });
    expect(out).toHaveLength(2);
  });

  it("ignores a pairing between two still-active members under void mode", () => {
    const rows = [{ playerId: "alice", droppedResults: [] }, { playerId: "bob", droppedResults: [] }];
    const out = buildUncounted(members, rows, [{ playerAId: "alice", playerBId: "bob" }], "void");
    expect(out).toEqual([]);
  });

  it("ignores a ghost pairing between two DROPPED members under void mode", () => {
    const withTwoDropped = [...members, { playerId: "eve", status: "DROPPED" as const }];
    const out = buildUncounted(withTwoDropped, [], [{ playerAId: "dave", playerBId: "eve" }], "void");
    expect(out).toEqual([]);
  });

  it("is empty when nothing is set aside", () => {
    const rows = [{ playerId: "alice", droppedResults: [] }];
    expect(buildUncounted(members, rows, [], "count")).toEqual([]);
    expect(buildUncounted(members, rows, [], "void")).toEqual([]);
  });
});
