import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  toPageStatus,
  matchesStatusFilter,
  parseStatusFilter,
  parseOlderThanDays,
  involvesDroppedPlayer,
  filterMatchRows,
  groupMatchRows,
  resolveSeasonId,
  type MatchPageRow,
  type MatchPageFilters,
  type MatchPageStatus,
  type PlayerStanding,
  type Suggestion,
  type SeasonOption,
} from "./matches-page-core.js";
import type { RowStatus } from "./bulk-resolve-core.js";

const NOW = new Date("2026-06-15T00:00:00Z");

function standing(overrides: Partial<PlayerStanding> = {}): PlayerStanding {
  return {
    playerId: "p1",
    displayName: "Alice",
    memberStatus: "ACTIVE",
    droppedAt: null,
    checkinStatus: null,
    checkinAt: null,
    checkinIssue: null,
    ...overrides,
  };
}

const LEAVE: Suggestion = { action: "leave", reason: "leave -- both active and recent" };

function row(overrides: Partial<MatchPageRow> = {}): MatchPageRow {
  return {
    matchId: "m1",
    divisionId: "d1",
    divisionName: "Division 1",
    tierName: "Rare",
    tierPosition: 2,
    format: "LEAGUE_BO2",
    pageStatus: "PENDING",
    playerA: standing({ playerId: "p1", displayName: "Alice" }),
    playerB: standing({ playerId: "p2", displayName: "Bob" }),
    gamesWonA: 0,
    gamesWonB: 0,
    forfeit: false,
    lastTouchedAt: NOW,
    daysSinceTouch: 0,
    suggestion: LEAVE,
    dispute: null,
    ...overrides,
  };
}

describe("toPageStatus", () => {
  it.each<{ status: RowStatus; expected: MatchPageStatus }>([
    { status: "PENDING", expected: "PENDING" },
    { status: "DISPUTED", expected: "DISPUTED" },
    { status: "UNPLAYED_SCHEDULED", expected: "UNPLAYED_SCHEDULED" },
    { status: "OTHER", expected: "RECORDED" },
  ])("$status -> $expected", ({ status, expected }) => {
    expect(toPageStatus(status)).toBe(expected);
  });
});

describe("parseStatusFilter / parseOlderThanDays", () => {
  it.each<{ raw: string | undefined; expected: string }>([
    { raw: undefined, expected: "all" },
    { raw: "", expected: "all" },
    { raw: "bogus", expected: "all" },
    { raw: "pending", expected: "pending" },
    { raw: "disputed", expected: "disputed" },
    { raw: "unplayed", expected: "unplayed" },
    { raw: "recorded", expected: "recorded" },
    { raw: "all", expected: "all" },
  ])("parseStatusFilter($raw) -> $expected", ({ raw, expected }) => {
    expect(parseStatusFilter(raw)).toBe(expected);
  });

  it.each<{ raw: string | undefined; expected: number | undefined }>([
    { raw: undefined, expected: undefined },
    { raw: "", expected: undefined },
    { raw: "abc", expected: undefined },
    { raw: "-5", expected: undefined },
    { raw: "0", expected: 0 },
    { raw: "7", expected: 7 },
    { raw: "7.9", expected: 7 },
  ])("parseOlderThanDays($raw) -> $expected", ({ raw, expected }) => {
    expect(parseOlderThanDays(raw)).toBe(expected);
  });
});

describe("matchesStatusFilter", () => {
  it.each<{ pageStatus: MatchPageStatus; filter: ReturnType<typeof parseStatusFilter>; expected: boolean }>([
    { pageStatus: "PENDING", filter: "all", expected: true },
    { pageStatus: "PENDING", filter: "pending", expected: true },
    { pageStatus: "PENDING", filter: "disputed", expected: false },
    { pageStatus: "DISPUTED", filter: "disputed", expected: true },
    { pageStatus: "UNPLAYED_SCHEDULED", filter: "unplayed", expected: true },
    { pageStatus: "RECORDED", filter: "recorded", expected: true },
    { pageStatus: "RECORDED", filter: "pending", expected: false },
  ])("$pageStatus vs $filter -> $expected", ({ pageStatus, filter, expected }) => {
    expect(matchesStatusFilter(pageStatus, filter)).toBe(expected);
  });
});

describe("involvesDroppedPlayer", () => {
  it("false when both active", () => {
    expect(involvesDroppedPlayer(row())).toBe(false);
  });
  it("true when player A dropped", () => {
    expect(involvesDroppedPlayer(row({ playerA: standing({ memberStatus: "DROPPED" }) }))).toBe(true);
  });
  it("true when player B dropped", () => {
    expect(involvesDroppedPlayer(row({ playerB: standing({ memberStatus: "DROPPED" }) }))).toBe(true);
  });
});

describe("filterMatchRows -- table scenarios", () => {
  const rows = [
    row({ matchId: "disputed-1", divisionId: "d1", pageStatus: "DISPUTED", daysSinceTouch: 2 }),
    row({ matchId: "pending-1", divisionId: "d1", pageStatus: "PENDING", daysSinceTouch: 10 }),
    row({ matchId: "unplayed-1", divisionId: "d2", pageStatus: "UNPLAYED_SCHEDULED", daysSinceTouch: 1 }),
    row({
      matchId: "recorded-1",
      divisionId: "d2",
      pageStatus: "RECORDED",
      daysSinceTouch: 0,
      playerB: standing({ playerId: "p2", displayName: "Bob", memberStatus: "DROPPED" }),
    }),
  ];

  it.each<{ name: string; filters: MatchPageFilters; expectedIds: string[] }>([
    {
      name: "all, no extra filters -- everything",
      filters: { status: "all", droppedOnly: false },
      expectedIds: ["disputed-1", "pending-1", "unplayed-1", "recorded-1"],
    },
    {
      name: "status=disputed",
      filters: { status: "disputed", droppedOnly: false },
      expectedIds: ["disputed-1"],
    },
    {
      name: "status=recorded",
      filters: { status: "recorded", droppedOnly: false },
      expectedIds: ["recorded-1"],
    },
    {
      name: "division=d1",
      filters: { status: "all", droppedOnly: false, divisionId: "d1" },
      expectedIds: ["disputed-1", "pending-1"],
    },
    {
      name: "olderThanDays=2 keeps >= 2 only",
      filters: { status: "all", droppedOnly: false, olderThanDays: 2 },
      expectedIds: ["disputed-1", "pending-1"],
    },
    {
      name: "droppedOnly keeps only rows with a dropped player",
      filters: { status: "all", droppedOnly: true },
      expectedIds: ["recorded-1"],
    },
    {
      name: "combined division + status",
      filters: { status: "unplayed", droppedOnly: false, divisionId: "d2" },
      expectedIds: ["unplayed-1"],
    },
  ])("$name", ({ filters, expectedIds }) => {
    const result = filterMatchRows(rows, filters).map((r) => r.matchId);
    expect(result).toEqual(expectedIds);
  });

  it("filtering is idempotent -- filtering the result again changes nothing", () => {
    const filters: MatchPageFilters = { status: "all", droppedOnly: false, olderThanDays: 1 };
    const once = filterMatchRows(rows, filters);
    const twice = filterMatchRows(once, filters);
    expect(twice).toEqual(once);
  });

  it("order-independence -- shuffling the input rows doesn't change the filtered set", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([...rows], { minLength: rows.length, maxLength: rows.length }), (shuffled) => {
        const filters: MatchPageFilters = { status: "all", droppedOnly: false };
        const ids = (rs: typeof rows) => new Set(filterMatchRows(rs, filters).map((r) => r.matchId));
        expect(ids(shuffled)).toEqual(ids(rows));
      }),
    );
  });
});

describe("groupMatchRows", () => {
  it("every row appears in exactly one group (partition / conservation)", () => {
    const rows = [
      row({ matchId: "a", pageStatus: "RECORDED", daysSinceTouch: 3 }),
      row({ matchId: "b", pageStatus: "DISPUTED", daysSinceTouch: 1 }),
      row({ matchId: "c", pageStatus: "PENDING", daysSinceTouch: 5 }),
      row({ matchId: "d", pageStatus: "UNPLAYED_SCHEDULED", daysSinceTouch: 0 }),
      row({ matchId: "e", pageStatus: "RECORDED", daysSinceTouch: 1 }),
    ];
    const groups = groupMatchRows(rows);
    const total = groups.reduce((sum, g) => sum + g.rows.length, 0);
    expect(total).toBe(rows.length);
    const seen = new Set(groups.flatMap((g) => g.rows.map((r) => r.matchId)));
    expect(seen.size).toBe(rows.length);
  });

  it("groups appear in priority order: Disputed, Pending, Unplayed, Recorded", () => {
    const rows = [
      row({ matchId: "r1", pageStatus: "RECORDED" }),
      row({ matchId: "u1", pageStatus: "UNPLAYED_SCHEDULED" }),
      row({ matchId: "p1", pageStatus: "PENDING" }),
      row({ matchId: "d1", pageStatus: "DISPUTED" }),
    ];
    const groups = groupMatchRows(rows);
    expect(groups.map((g) => g.status)).toEqual(["DISPUTED", "PENDING", "UNPLAYED_SCHEDULED", "RECORDED"]);
  });

  it("omits empty groups", () => {
    const groups = groupMatchRows([row({ pageStatus: "RECORDED" })]);
    expect(groups).toEqual([{ status: "RECORDED", rows: [groups[0]!.rows[0]!] }]);
  });

  it("sorts unresolved groups stalest-first, Recorded most-recent-first", () => {
    const rows = [
      row({ matchId: "p-stale", pageStatus: "PENDING", daysSinceTouch: 10 }),
      row({ matchId: "p-fresh", pageStatus: "PENDING", daysSinceTouch: 1 }),
      row({ matchId: "r-old", pageStatus: "RECORDED", daysSinceTouch: 10 }),
      row({ matchId: "r-new", pageStatus: "RECORDED", daysSinceTouch: 1 }),
    ];
    const groups = groupMatchRows(rows);
    const pending = groups.find((g) => g.status === "PENDING")!;
    expect(pending.rows.map((r) => r.matchId)).toEqual(["p-stale", "p-fresh"]);
    const recorded = groups.find((g) => g.status === "RECORDED")!;
    expect(recorded.rows.map((r) => r.matchId)).toEqual(["r-new", "r-old"]);
  });

  it("order-independence -- shuffling input rows doesn't change any group's row-id set", () => {
    const rows = [
      row({ matchId: "a", pageStatus: "RECORDED", daysSinceTouch: 3 }),
      row({ matchId: "b", pageStatus: "DISPUTED", daysSinceTouch: 1 }),
      row({ matchId: "c", pageStatus: "PENDING", daysSinceTouch: 5 }),
      row({ matchId: "d", pageStatus: "UNPLAYED_SCHEDULED", daysSinceTouch: 0 }),
      row({ matchId: "e", pageStatus: "RECORDED", daysSinceTouch: 1 }),
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length }), (shuffled) => {
        const byStatus = (rs: typeof rows) =>
          groupMatchRows(rs).map((g) => ({ status: g.status, ids: g.rows.map((r) => r.matchId) }));
        expect(byStatus(shuffled)).toEqual(byStatus(rows));
      }),
    );
  });
});

describe("resolveSeasonId", () => {
  const seasons: SeasonOption[] = [
    { id: "s1", number: 1, isActive: false },
    { id: "s2", number: 2, isActive: false },
    { id: "s3", number: 3, isActive: true },
  ];

  it.each<{ name: string; seasons: SeasonOption[]; requested: string | undefined; expected: string | null }>([
    { name: "requested id exists -- use it even if not active", seasons, requested: "s1", expected: "s1" },
    { name: "no request -- falls back to the active season", seasons, requested: undefined, expected: "s3" },
    {
      name: "requested id doesn't exist -- falls back to active",
      seasons,
      requested: "nope",
      expected: "s3",
    },
    {
      name: "no active season -- falls back to the highest season number",
      seasons: [
        { id: "s1", number: 1, isActive: false },
        { id: "s2", number: 2, isActive: false },
      ],
      requested: undefined,
      expected: "s2",
    },
    { name: "empty season list -- null", seasons: [], requested: undefined, expected: null },
  ])("$name", ({ seasons, requested, expected }) => {
    expect(resolveSeasonId(seasons, requested)).toBe(expected);
  });

  it("order-independence -- shuffling the season list never changes the fallback pick", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(seasons, { minLength: seasons.length, maxLength: seasons.length }), (shuffled) => {
        expect(resolveSeasonId(shuffled, undefined)).toBe("s3");
      }),
    );
  });
});
