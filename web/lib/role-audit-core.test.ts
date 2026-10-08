import { describe, it, expect } from "vitest";
import {
  matchChampionRole,
  auditRoles,
  buildSeasonRecords,
  parseWinnerRole,
  buildWinnerExpectations,
  type GuildRole,
  type GuildMemberRoles,
  type RoleExpectation,
  type SeasonMembershipRecord,
} from "./role-audit-core.js";

const role = (id: string, name: string, managed = false): GuildRole => ({ id, name, managed });
const member = (discordId: string, roles: string[], label = discordId): GuildMemberRoles => ({
  discordId,
  roles,
  label,
});

const TIER_NAMES = ["Common", "Uncommon", "Rare", "Legendary"];

const membership = (overrides: Partial<SeasonMembershipRecord>): SeasonMembershipRecord => ({
  playerId: "p1",
  discordId: "d1",
  displayName: "Alice",
  seasonNumber: 1,
  seasonLabel: "Season 1",
  divisionName: "Rare 1",
  tierName: "Rare",
  tierPosition: 2,
  finalGlobalRank: null,
  finish: null,
  champion: false,
  ...overrides,
});

describe("matchChampionRole", () => {
  it("matches the bootstrap name exactly, trophy emoji and all", () => {
    const roles = [role("r1", `${"\u{1F3C6}"} Season 8 Rare 2 Champion`)];
    expect(matchChampionRole(roles, 8, "Season 8", "Rare 2")).toEqual(roles[0]);
  });

  it("matches case-insensitively with no emoji", () => {
    const roles = [role("r1", "season 8 rare 2 champion")];
    expect(matchChampionRole(roles, 8, "Season 8", "Rare 2")).toEqual(roles[0]);
  });

  it("matches via the season label when it carries a subtitle", () => {
    const roles = [role("r1", "\u{1F3C6} Season 8 -- Launch Rare 2 Champion")];
    expect(matchChampionRole(roles, 8, "Season 8 -- Launch", "Rare 2")).toEqual(roles[0]);
  });

  it("does NOT match a hand-made name that never spells out the season (ambiguous = null)", () => {
    // "S8" is not "Season 8" and the role name doesn't contain the label either --
    // documented rule: a role must literally reference "season <n>" or the full
    // label, not just an abbreviation, or it's treated as unresolved.
    const roles = [role("r1", "S8 Rare 2 Champion")];
    expect(matchChampionRole(roles, 8, "Season 8", "Rare 2")).toBeNull();
  });

  it("returns null when no role contains 'champion'", () => {
    const roles = [role("r1", "Season 8 Rare 2")];
    expect(matchChampionRole(roles, 8, "Season 8", "Rare 2")).toBeNull();
  });

  it("returns null when no candidate references this division", () => {
    const roles = [role("r1", "\u{1F3C6} Season 8 Rare 1 Champion")];
    expect(matchChampionRole(roles, 8, "Season 8", "Rare 2")).toBeNull();
  });

  it("returns null when multiple candidates match (ambiguous)", () => {
    const roles = [
      role("r1", "\u{1F3C6} Season 8 Rare 2 Champion"),
      role("r2", "Season 8 Rare 2 Champion (duplicate)"),
    ];
    expect(matchChampionRole(roles, 8, "Season 8", "Rare 2")).toBeNull();
  });

  it("excludes managed (integration) roles even if the name matches", () => {
    const roles = [role("r1", "\u{1F3C6} Season 8 Rare 2 Champion", true)];
    expect(matchChampionRole(roles, 8, "Season 8", "Rare 2")).toBeNull();
  });
});

describe("auditRoles", () => {
  it("sorts expected holders into ok/missing/extra/notInGuild", () => {
    const roles: GuildRole[] = [role("league", "League Player")];
    const members: GuildMemberRoles[] = [
      member("alice", ["league"]),
      member("bob", []),
      member("carol", ["league"]),
    ];
    const expectations: RoleExpectation[] = [
      {
        roleId: "league",
        roleName: "League Player",
        kind: "league-player",
        description: "Active league roster",
        expected: ["alice", "bob", "dave"],
      },
    ];
    const report = auditRoles(roles, members, expectations, "guild1");
    expect(report.entries).toEqual([
      {
        roleId: "league",
        roleName: "League Player",
        kind: "league-player",
        description: "Active league roster",
        expectedCount: 3,
        holderCount: 2,
        ok: ["alice"],
        missing: ["bob"],
        extra: ["carol"],
        notInGuild: ["dave"],
      },
    ]);
    // dave (notInGuild) still counts toward totals.missing even though he's
    // not actionable by the fix button -- the summary shouldn't hide him.
    expect(report.totals).toEqual({ missing: 2, extra: 1 });
  });

  it("excludes @everyone (role id === guildId) and managed roles from unmapped", () => {
    const roles: GuildRole[] = [
      role("guild1", "@everyone"),
      role("bot-role", "MEE6", true),
      role("star", "\u2b50 Star"),
    ];
    const members: GuildMemberRoles[] = [member("alice", ["guild1", "bot-role", "star"])];
    const report = auditRoles(roles, members, [], "guild1");
    expect(report.unmapped).toEqual([{ roleId: "star", roleName: "\u2b50 Star", holders: ["alice"] }]);
  });

  it("excludes roles already covered by an expectation from unmapped", () => {
    const roles: GuildRole[] = [role("league", "League Player"), role("star", "\u2b50 Star")];
    const members: GuildMemberRoles[] = [member("alice", ["league", "star"])];
    const expectations: RoleExpectation[] = [
      { roleId: "league", roleName: "League Player", kind: "league-player", description: "", expected: ["alice"] },
    ];
    const report = auditRoles(roles, members, expectations, "guild1");
    expect(report.unmapped.map((u) => u.roleId)).toEqual(["star"]);
  });

  it("sorts unmapped roles by holder count descending, stable on ties", () => {
    const roles: GuildRole[] = [role("a", "A"), role("b", "B"), role("c", "C")];
    const members: GuildMemberRoles[] = [
      member("p1", ["a"]),
      member("p2", ["b"]),
      member("p3", ["b"]),
      member("p4", ["b"]),
    ];
    const report = auditRoles(roles, members, [], "guild1");
    expect(report.unmapped.map((u) => u.roleId)).toEqual(["b", "a", "c"]);
  });

  it("returns empty totals and no entries/unmapped for a clean, fully-mapped guild", () => {
    const roles: GuildRole[] = [role("league", "League Player")];
    const members: GuildMemberRoles[] = [member("alice", ["league"])];
    const expectations: RoleExpectation[] = [
      { roleId: "league", roleName: "League Player", kind: "league-player", description: "", expected: ["alice"] },
    ];
    const report = auditRoles(roles, members, expectations, "guild1");
    expect(report.totals).toEqual({ missing: 0, extra: 0 });
    expect(report.unmapped).toEqual([]);
    expect(report.entries[0]!.ok).toEqual(["alice"]);
    expect(report.entries[0]!.missing).toEqual([]);
    expect(report.entries[0]!.extra).toEqual([]);
    expect(report.entries[0]!.notInGuild).toEqual([]);
  });

  it("handles multiple expectations independently (division + champion kinds)", () => {
    const roles: GuildRole[] = [role("div", "Season 8: Rare 2"), role("champ", "\u{1F3C6} Season 8 Rare 2 Champion")];
    const members: GuildMemberRoles[] = [
      member("alice", ["div", "champ"]),
      member("bob", ["div"]),
    ];
    const expectations: RoleExpectation[] = [
      { roleId: "div", roleName: "Season 8: Rare 2", kind: "division", description: "", expected: ["alice", "bob"] },
      { roleId: "champ", roleName: "\u{1F3C6} Season 8 Rare 2 Champion", kind: "champion", description: "", expected: ["alice"] },
    ];
    const report = auditRoles(roles, members, expectations, "guild1");
    expect(report.entries.map((e) => e.kind)).toEqual(["division", "champion"]);
    expect(report.entries[0]!.ok).toEqual(["alice", "bob"]);
    expect(report.entries[1]!.ok).toEqual(["alice"]);
    expect(report.totals).toEqual({ missing: 0, extra: 0 });
  });
});

describe("buildSeasonRecords", () => {
  it("groups memberships by player, counting titles overall and by tier", () => {
    const records = buildSeasonRecords([
      membership({ seasonNumber: 6, divisionName: "Rare 2", champion: true }),
      membership({ seasonNumber: 7, divisionName: "Rare 1", champion: false }),
      membership({ seasonNumber: 8, divisionName: "Legendary", tierName: "Legendary", tierPosition: 1, champion: true }),
    ]);
    expect(records).toEqual([
      {
        playerId: "p1",
        discordId: "d1",
        displayName: "Alice",
        seasonsPlayed: 3,
        titles: 2,
        titlesByTier: { Rare: 1, Legendary: 1 },
        memberships: [
          membership({ seasonNumber: 6, divisionName: "Rare 2", champion: true }),
          membership({ seasonNumber: 7, divisionName: "Rare 1", champion: false }),
          membership({ seasonNumber: 8, divisionName: "Legendary", tierName: "Legendary", tierPosition: 1, champion: true }),
        ],
      },
    ]);
  });

  it("sorts by titles descending, then displayName ascending", () => {
    const records = buildSeasonRecords([
      membership({ playerId: "p1", discordId: "d1", displayName: "Zed", champion: false }),
      membership({ playerId: "p2", discordId: "d2", displayName: "Bob", champion: true }),
      membership({ playerId: "p3", discordId: "d3", displayName: "Amy", champion: true }),
    ]);
    expect(records.map((r) => r.displayName)).toEqual(["Amy", "Bob", "Zed"]);
  });

  it("keeps memberships for a player sorted by season number ascending", () => {
    const records = buildSeasonRecords([
      membership({ seasonNumber: 8, divisionName: "C" }),
      membership({ seasonNumber: 6, divisionName: "A" }),
      membership({ seasonNumber: 7, divisionName: "B" }),
    ]);
    expect(records[0]!.memberships.map((m) => m.seasonNumber)).toEqual([6, 7, 8]);
  });
});

describe("parseWinnerRole", () => {
  it("parses the Common/Uncommon trap correctly -- longest tier name wins", () => {
    expect(parseWinnerRole("2x Uncommon Winner", TIER_NAMES)).toEqual({ tierName: "Uncommon", count: 2 });
  });

  it("parses a trailing 'x<n>' count form", () => {
    expect(parseWinnerRole("Rare Winner x2", TIER_NAMES)).toEqual({ tierName: "Rare", count: 2 });
  });

  it("parses a leading '<n>x' count form", () => {
    expect(parseWinnerRole("3x Legendary Winner", TIER_NAMES)).toEqual({ tierName: "Legendary", count: 3 });
  });

  it("parses a run of star emoji as the count", () => {
    const twoStars = String.fromCodePoint(0x2b50) + String.fromCodePoint(0x2b50);
    expect(parseWinnerRole(`Rare Winner ${twoStars}`, TIER_NAMES)).toEqual({ tierName: "Rare", count: 2 });
  });

  it("parses a run of glowing-star emoji as the count", () => {
    const threeStars = String.fromCodePoint(0x1f31f).repeat(3);
    expect(parseWinnerRole(`Common Winner ${threeStars}`, TIER_NAMES)).toEqual({ tierName: "Common", count: 3 });
  });

  it("returns null when there is no count at all", () => {
    expect(parseWinnerRole("Rare Winner", TIER_NAMES)).toBeNull();
  });

  it("returns null when no tier name is present", () => {
    expect(parseWinnerRole("2x Winner", TIER_NAMES)).toBeNull();
  });

  it("returns null when two unrelated tier names both appear (genuine ambiguity)", () => {
    expect(parseWinnerRole("2x Rare Legendary Winner", TIER_NAMES)).toBeNull();
  });
});

describe("buildWinnerExpectations", () => {
  const twoRareTitleRecords = buildSeasonRecords([
    membership({ playerId: "p1", discordId: "alice", displayName: "Alice", seasonNumber: 6, tierName: "Rare", champion: true }),
    membership({ playerId: "p1", discordId: "alice", displayName: "Alice", seasonNumber: 7, tierName: "Rare", champion: true }),
  ]);

  it("expects a player with exactly N titles on the Nx role only, and nowhere else", () => {
    const roles = [role("r1", "1x Rare Winner"), role("r2", "2x Rare Winner")];
    const { expectations, missingWinnerRoles } = buildWinnerExpectations(roles, twoRareTitleRecords, TIER_NAMES);
    expect(expectations).toEqual([
      { roleId: "r1", roleName: "1x Rare Winner", kind: "winner", description: "1x Rare winner", expected: [] },
      { roleId: "r2", roleName: "2x Rare Winner", kind: "winner", description: "2x Rare winner", expected: ["alice"] },
    ]);
    expect(missingWinnerRoles).toEqual([]);
  });

  it("flags holding the wrong count's role as extra there and missing on the correct one", () => {
    const roles = [role("r1", "1x Rare Winner"), role("r2", "2x Rare Winner")];
    const { expectations } = buildWinnerExpectations(roles, twoRareTitleRecords, TIER_NAMES);
    const members = [member("alice", ["r1"])]; // holds the WRONG (1x) role, not the correct 2x one
    const report = auditRoles(roles, members, expectations, "guild1");
    const r1Entry = report.entries.find((e) => e.roleId === "r1")!;
    const r2Entry = report.entries.find((e) => e.roleId === "r2")!;
    expect(r1Entry.extra).toEqual(["alice"]);
    expect(r2Entry.missing).toEqual(["alice"]);
  });

  it("surfaces a (tier, count) combo with players but no matching role", () => {
    const roles = [role("r1", "1x Rare Winner")];
    const { missingWinnerRoles } = buildWinnerExpectations(roles, twoRareTitleRecords, TIER_NAMES);
    expect(missingWinnerRoles).toEqual([{ tierName: "Rare", count: 2, players: ["alice"] }]);
  });

  it("excludes managed roles from winner-role parsing", () => {
    const roles = [role("r1", "2x Rare Winner", true)];
    const { expectations, missingWinnerRoles } = buildWinnerExpectations(roles, twoRareTitleRecords, TIER_NAMES);
    expect(expectations).toEqual([]);
    expect(missingWinnerRoles).toEqual([{ tierName: "Rare", count: 2, players: ["alice"] }]);
  });
});
