import { describe, it, expect } from "vitest";
import {
  auditSeason,
  checkOpenMatches,
  checkUnsettledCancels,
  checkTies,
  checkChampion,
  checkFinalRanks,
  checkStandingsMissing,
  checkDivisionDiscordLeftovers,
  checkSeasonDiscordLeftovers,
  checkShootoutDangling,
  type SeasonAuditDivisionInput,
  type SeasonAuditInput,
  type SeasonAuditMatchInput,
  type SeasonAuditMemberInput,
  type SeasonAuditStandingRowInput,
} from "./season-audit-core.js";

const SEASON_ID = "season-1";

function member(playerId: string, displayName: string, overrides: Partial<SeasonAuditMemberInput> = {}): SeasonAuditMemberInput {
  return { playerId, displayName, status: "ACTIVE", finalGlobalRank: null, ...overrides };
}

function row(playerId: string, displayName: string, rank: number, overrides: Partial<SeasonAuditStandingRowInput> = {}): SeasonAuditStandingRowInput {
  return { playerId, displayName, rank, points: 0, ...overrides };
}

function match(overrides: Partial<SeasonAuditMatchInput> = {}): SeasonAuditMatchInput {
  return {
    id: "m1",
    format: "LEAGUE_BO2",
    status: "CONFIRMED",
    playerAId: "p1",
    playerBId: "p2",
    winnerId: "p1",
    adminOverrideBy: null,
    gamesWonA: 2,
    gamesWonB: 0,
    recordedBy: null,
    ...overrides,
  };
}

function division(overrides: Partial<SeasonAuditDivisionInput> = {}): SeasonAuditDivisionInput {
  return {
    divisionId: "div-1",
    name: "Legendary",
    tierPosition: 1,
    groupNumber: 1,
    promoteCount: 1,
    relegateCount: 1,
    isFirst: true,
    isLast: false,
    championPlayerId: null,
    discordChannelId: null,
    discordRoleId: null,
    members: [],
    rows: null,
    matches: [],
    ...overrides,
  };
}

function seasonInput(overrides: Partial<SeasonAuditInput> = {}): SeasonAuditInput {
  return {
    seasonId: SEASON_ID,
    seasonLabel: "Season 1",
    ended: true,
    divisions: [],
    leaguePlayerRoleId: null,
    discordCategoryId: null,
    ...overrides,
  };
}

describe("checkOpenMatches", () => {
  it.each([
    ["flags a PENDING LEAGUE_BO2 between two active members when ended", true, "PENDING", true, 1],
    ["flags a DISPUTED LEAGUE_BO2 between two active members when ended", true, "DISPUTED", true, 1],
    ["does not flag when the season has not ended", false, "PENDING", true, 0],
    ["does not flag a SHOOTOUT_BO1", true, "PENDING", true, 0],
    ["does not flag when one player has dropped", true, "PENDING", false, 0],
  ] as const)("%s", (_name, ended, status, bothActive, expectedCount) => {
    const d = division({
      members: [member("p1", "Alice"), member("p2", "Bob", bothActive ? {} : { status: "DROPPED" })],
      matches: [
        _name.includes("SHOOTOUT")
          ? match({ format: "SHOOTOUT_BO1", status: "PENDING" })
          : match({ status: status as "PENDING" | "DISPUTED" }),
      ],
    });
    expect(checkOpenMatches(d, ended)).toHaveLength(expectedCount);
  });

  it("names both players and links to the resolve queue", () => {
    const d = division({
      members: [member("p1", "Alice"), member("p2", "Bob")],
      matches: [match({ status: "PENDING" })],
    });
    const findings = checkOpenMatches(d, true);
    expect(findings).toEqual([
      {
        severity: "error",
        code: "open-match",
        divisionId: "div-1",
        divisionName: "Legendary",
        message: "Open match (PENDING) between Alice and Bob was never resolved",
        href: "/admin/resolve",
      },
    ]);
  });
});

describe("checkUnsettledCancels", () => {
  it("flags a CANCELLED LEAGUE_BO2 between active members with no adminOverrideBy", () => {
    const d = division({
      members: [member("p1", "Alice"), member("p2", "Bob")],
      matches: [match({ status: "CANCELLED", adminOverrideBy: null })],
    });
    expect(checkUnsettledCancels(d)).toHaveLength(1);
    expect(checkUnsettledCancels(d)[0]!.severity).toBe("warn");
  });

  it("does not flag a CANCELLED match with an admin reason recorded", () => {
    const d = division({
      members: [member("p1", "Alice"), member("p2", "Bob")],
      matches: [match({ status: "CANCELLED", adminOverrideBy: "admin1" })],
    });
    expect(checkUnsettledCancels(d)).toHaveLength(0);
  });

  it("does not flag a CONFIRMED match", () => {
    const d = division({
      members: [member("p1", "Alice"), member("p2", "Bob")],
      matches: [match({ status: "CONFIRMED" })],
    });
    expect(checkUnsettledCancels(d)).toHaveLength(0);
  });
});

describe("checkTies", () => {
  it("returns nothing when standings are missing", () => {
    expect(checkTies(division({ rows: null }))).toEqual([]);
  });

  it("flags a tie for #1 as tie-on-line (error)", () => {
    const d = division({
      promoteCount: 1,
      relegateCount: 1,
      isFirst: true,
      isLast: false,
      rows: [row("p1", "Alice", 1), row("p2", "Bob", 1, { tiedWithPrev: true }), row("p3", "Carl", 3)],
    });
    const findings = checkTies(d);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", code: "tie-on-line" });
    expect(findings[0]!.message).toContain("#1");
  });

  it("flags a tie straddling the promotion boundary as tie-on-line", () => {
    // 4-row division, promoteCount=1, not the first division -> boundary is
    // positions 1/2. Tie sits at rank 1/2 here too, so use a non-#1 boundary
    // by giving the division promoteCount=2 so the boundary is positions 2/3.
    const d = division({
      promoteCount: 2,
      relegateCount: 1,
      isFirst: false,
      isLast: false,
      rows: [
        row("p1", "Alice", 1),
        row("p2", "Bob", 2),
        row("p3", "Carl", 2, { tiedWithPrev: true }),
        row("p4", "Dana", 4),
      ],
    });
    const findings = checkTies(d);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", code: "tie-on-line" });
    expect(findings[0]!.message).toContain("promotion");
  });

  it("flags a tie straddling the relegation boundary as tie-on-line", () => {
    const d = division({
      promoteCount: 1,
      relegateCount: 2,
      isFirst: false,
      isLast: false,
      rows: [
        row("p1", "Alice", 1),
        row("p2", "Bob", 2),
        row("p3", "Carl", 2, { tiedWithPrev: true }),
        row("p4", "Dana", 4),
      ],
    });
    const findings = checkTies(d);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", code: "tie-on-line" });
    expect(findings[0]!.message).toContain("relegation");
  });

  it("flags a harmless mid-table tie as tie-elsewhere (info)", () => {
    const d = division({
      promoteCount: 1,
      relegateCount: 1,
      isFirst: false,
      isLast: false,
      rows: [
        row("p1", "Alice", 1),
        row("p2", "Bob", 2),
        row("p3", "Carl", 3),
        row("p4", "Dana", 3, { tiedWithPrev: true }),
        row("p5", "Eve", 5),
      ],
    });
    const findings = checkTies(d);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "info", code: "tie-elsewhere" });
  });

  it("ignores a tie involving a dropped row", () => {
    const d = division({
      rows: [
        row("p1", "Alice", 1),
        row("p2", "Bob", 1, { tiedWithPrev: true, dropped: true }),
      ],
    });
    // Dropped rows are filtered out before adjacency is checked, so Bob
    // never becomes "adjacent" to anyone and there is nothing left to flag.
    expect(checkTies(d)).toEqual([]);
  });

  it("the top division never treats its top rows as a promotion boundary", () => {
    const d = division({
      promoteCount: 1,
      isFirst: true,
      isLast: false,
      rows: [row("p1", "Alice", 1), row("p2", "Bob", 1, { tiedWithPrev: true }), row("p3", "Carl", 3)],
    });
    // Still flagged -- but as a #1 tie, not a promotion-boundary tie (promote=0 here).
    const findings = checkTies(d);
    expect(findings[0]!.message).toContain("#1");
    expect(findings[0]!.message).not.toContain("promotion");
  });
});

describe("checkChampion", () => {
  it("does nothing when the season has not ended", () => {
    const d = division({ rows: [row("p1", "Alice", 1)], championPlayerId: null });
    expect(checkChampion(d, false, SEASON_ID)).toEqual([]);
  });

  it("is silent when championPlayerId is null but #1 is unique (champion is derived)", () => {
    const d = division({ rows: [row("p1", "Alice", 1), row("p2", "Bob", 2)], championPlayerId: null });
    expect(checkChampion(d, true, SEASON_ID)).toEqual([]);
  });

  it("flags no-champion (warn) when championPlayerId is null and #1 is tied", () => {
    const d = division({ rows: [row("p1", "Alice", 1), row("p2", "Bob", 1, { tiedWithPrev: true })], championPlayerId: null });
    const findings = checkChampion(d, true, SEASON_ID);
    expect(findings).toEqual([
      {
        severity: "warn",
        code: "no-champion",
        divisionId: "div-1",
        divisionName: "Legendary",
        message: "Tie for #1 in Legendary and no champion recorded -- pick the winner on the winners page",
        href: "/admin/seasons/season-1/winners",
      },
    ]);
  });

  it("flags champion-mismatch (error) when championPlayerId is not the rank-1 row", () => {
    const d = division({
      rows: [row("p1", "Alice", 1), row("p2", "Bob", 2)],
      championPlayerId: "p2",
    });
    const findings = checkChampion(d, true, SEASON_ID);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", code: "champion-mismatch" });
  });

  it("passes when championPlayerId matches the rank-1 row", () => {
    const d = division({ rows: [row("p1", "Alice", 1)], championPlayerId: "p1" });
    expect(checkChampion(d, true, SEASON_ID)).toEqual([]);
  });

  it("passes when championPlayerId matches one of several tied rank-1 rows", () => {
    const d = division({
      rows: [row("p1", "Alice", 1), row("p2", "Bob", 1, { tiedWithPrev: true })],
      championPlayerId: "p2",
    });
    expect(checkChampion(d, true, SEASON_ID)).toEqual([]);
  });

  it("does nothing when there are no rows at all", () => {
    const d = division({ rows: [], championPlayerId: null });
    expect(checkChampion(d, true, SEASON_ID)).toEqual([]);
  });
});

describe("checkFinalRanks", () => {
  it("does nothing when the season has not ended", () => {
    const d = division({ members: [member("p1", "Alice", { finalGlobalRank: null })] });
    expect(checkFinalRanks(d, false, SEASON_ID)).toEqual([]);
  });

  it("flags rank-missing (warn) for an ACTIVE member with no finalGlobalRank", () => {
    const d = division({ members: [member("p1", "Alice", { finalGlobalRank: null })] });
    const findings = checkFinalRanks(d, true, SEASON_ID);
    expect(findings).toEqual([
      {
        severity: "warn",
        code: "rank-missing",
        divisionId: "div-1",
        divisionName: "Legendary",
        message: "Alice has no final global rank recorded",
        href: "/admin/seasons/season-1/end",
      },
    ]);
  });

  it("does not flag a DROPPED member with no finalGlobalRank", () => {
    const d = division({ members: [member("p1", "Alice", { status: "DROPPED", finalGlobalRank: null })] });
    expect(checkFinalRanks(d, true, SEASON_ID)).toEqual([]);
  });

  it("flags rank-order (error) when finalGlobalRank order disagrees with the standings order", () => {
    const d = division({
      members: [member("p1", "Alice", { finalGlobalRank: 2 }), member("p2", "Bob", { finalGlobalRank: 1 })],
      rows: [row("p1", "Alice", 1), row("p2", "Bob", 2)],
    });
    const findings = checkFinalRanks(d, true, SEASON_ID);
    expect(findings.some((f) => f.code === "rank-order")).toBe(true);
  });

  it("does not flag rank-order when the orders agree", () => {
    const d = division({
      members: [member("p1", "Alice", { finalGlobalRank: 1 }), member("p2", "Bob", { finalGlobalRank: 2 })],
      rows: [row("p1", "Alice", 1), row("p2", "Bob", 2)],
    });
    expect(checkFinalRanks(d, true, SEASON_ID).some((f) => f.code === "rank-order")).toBe(false);
  });

  it("tolerates equal finalGlobalRank for consecutive tied rows in either order", () => {
    const d = division({
      members: [member("p1", "Alice", { finalGlobalRank: 1 }), member("p2", "Bob", { finalGlobalRank: 1 })],
      rows: [row("p2", "Bob", 1), row("p1", "Alice", 1, { tiedWithPrev: true })],
    });
    expect(checkFinalRanks(d, true, SEASON_ID).some((f) => f.code === "rank-order")).toBe(false);
  });
});

describe("checkStandingsMissing", () => {
  it("flags standings-missing (warn) when rows is null", () => {
    const findings = checkStandingsMissing(division({ rows: null }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warn", code: "standings-missing" });
  });

  it("does not flag when rows is an empty array", () => {
    expect(checkStandingsMissing(division({ rows: [] }))).toEqual([]);
  });
});

describe("checkDivisionDiscordLeftovers / checkSeasonDiscordLeftovers", () => {
  it("does nothing when the season has not ended", () => {
    const d = division({ discordChannelId: "c1", discordRoleId: "r1" });
    expect(checkDivisionDiscordLeftovers(d, false, SEASON_ID)).toEqual([]);
  });

  it("flags a leftover division channel and role separately", () => {
    const d = division({ discordChannelId: "c1", discordRoleId: "r1" });
    const findings = checkDivisionDiscordLeftovers(d, true, SEASON_ID);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === "info" && f.code === "discord-leftover")).toBe(true);
  });

  it("flags nothing when the division has no Discord ids set", () => {
    expect(checkDivisionDiscordLeftovers(division(), true, SEASON_ID)).toEqual([]);
  });

  it("flags a leftover season category but not the shared League Player role", () => {
    const findings = checkSeasonDiscordLeftovers(
      seasonInput({ discordCategoryId: "cat1", leaguePlayerRoleId: "role1" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("discord-leftover");
    expect(findings[0]!.message).toContain("category");
  });

  it("flags nothing on an active season even with ids set", () => {
    expect(
      checkSeasonDiscordLeftovers(seasonInput({ ended: false, discordCategoryId: "cat1" })),
    ).toEqual([]);
  });
});

describe("checkShootoutDangling", () => {
  it("returns nothing when standings are missing", () => {
    const d = division({ rows: null, matches: [match({ format: "SHOOTOUT_BO1" })] });
    expect(checkShootoutDangling(d)).toEqual([]);
  });

  it("flags a CONFIRMED shootout between players who are not tied on points", () => {
    const d = division({
      members: [member("p1", "Alice"), member("p2", "Bob")],
      rows: [row("p1", "Alice", 1, { points: 9 }), row("p2", "Bob", 2, { points: 7 })],
      matches: [match({ format: "SHOOTOUT_BO1", status: "CONFIRMED" })],
    });
    const findings = checkShootoutDangling(d);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "info", code: "shootout-dangling" });
  });

  it("does not flag a shootout that broke a points tie (equal points, different rank)", () => {
    const d = division({
      rows: [row("p1", "Alice", 1, { points: 7 }), row("p2", "Bob", 2, { points: 7 })],
      matches: [match({ format: "SHOOTOUT_BO1", status: "CONFIRMED" })],
    });
    expect(checkShootoutDangling(d)).toEqual([]);
  });

  it("does not flag a shootout between players who are actually tied", () => {
    const d = division({
      rows: [row("p1", "Alice", 1, { points: 7 }), row("p2", "Bob", 1, { points: 7, tiedWithPrev: true })],
      matches: [match({ format: "SHOOTOUT_BO1", status: "CONFIRMED" })],
    });
    expect(checkShootoutDangling(d)).toEqual([]);
  });

  it("does not flag a PENDING shootout", () => {
    const d = division({
      rows: [row("p1", "Alice", 1), row("p2", "Bob", 2)],
      matches: [match({ format: "SHOOTOUT_BO1", status: "PENDING" })],
    });
    expect(checkShootoutDangling(d)).toEqual([]);
  });

  it("does not flag an admin-recorded shootout (recordedBy set), even when not tied on points", () => {
    const d = division({
      members: [member("p1", "Alice"), member("p2", "Bob")],
      rows: [row("p1", "Alice", 1, { points: 9 }), row("p2", "Bob", 2, { points: 7 })],
      matches: [match({ format: "SHOOTOUT_BO1", status: "CONFIRMED", recordedBy: "admin-discord-id" })],
    });
    expect(checkShootoutDangling(d)).toEqual([]);
  });
});

describe("auditSeason -- composed", () => {
  it("produces zero findings for a fully closed-out happy-path season", () => {
    const input = seasonInput({
      ended: true,
      leaguePlayerRoleId: null,
      discordCategoryId: null,
      divisions: [
        division({
          divisionId: "div-1",
          name: "Legendary",
          isFirst: true,
          isLast: true,
          championPlayerId: "p1",
          discordChannelId: null,
          discordRoleId: null,
          members: [
            member("p1", "Alice", { finalGlobalRank: 1 }),
            member("p2", "Bob", { finalGlobalRank: 2 }),
          ],
          rows: [row("p1", "Alice", 1), row("p2", "Bob", 2)],
          matches: [match({ status: "CONFIRMED", playerAId: "p1", playerBId: "p2" })],
        }),
      ],
    });

    const report = auditSeason(input);
    expect(report.findings).toEqual([]);
    expect(report.countsBySeverity).toEqual({ error: 0, warn: 0, info: 0 });
  });

  it("aggregates counts by severity across every check", () => {
    const input = seasonInput({
      ended: true,
      discordCategoryId: "cat1",
      divisions: [
        division({
          divisionId: "div-1",
          name: "Legendary",
          isFirst: true,
          isLast: true,
          championPlayerId: null, // unique #1 -> derived champion, no finding
          members: [member("p1", "Alice", { finalGlobalRank: null })], // rank-missing: warn
          rows: [row("p1", "Alice", 1)],
          matches: [match({ status: "PENDING", playerAId: "p1", playerBId: "p1x" })],
        }),
      ],
    });
    // playerBId "p1x" isn't an active member, so open-match should NOT fire;
    // only the rank-missing warn plus the season-level discord-leftover info.
    const report = auditSeason(input);
    expect(report.countsBySeverity).toEqual({ error: 0, warn: 1, info: 1 });
  });
});
