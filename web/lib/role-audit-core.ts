// Pure core for the /admin/roles "role audit" page. Zero prisma/discord/Date
// imports -- the shell (web/lib/loaders/role-audit.ts) gathers Discord roles +
// guild members + DB-derived expectations and hands them here as plain data;
// this file only decides who should have what role vs who actually does.

export interface GuildRole {
  id: string;
  name: string;
  managed: boolean;
}

// One guild member's current roles. `label` is a display fallback (nick or
// username) the shell resolves from the Discord member payload -- carried
// through on the type so callers building `members` have a natural home for
// it, though auditRoles itself only ever compares by discordId/roleId.
export interface GuildMemberRoles {
  discordId: string;
  roles: string[];
  label: string;
}

export type RoleExpectationKind = "league-player" | "division" | "champion" | "winner";

export interface RoleExpectation {
  roleId: string;
  roleName: string;
  kind: RoleExpectationKind;
  description: string;
  // discordIds who SHOULD hold this role.
  expected: string[];
}

export interface RoleAuditEntry {
  roleId: string;
  roleName: string;
  kind: RoleExpectationKind;
  description: string;
  expectedCount: number;
  holderCount: number;
  // Expected AND currently holding.
  ok: string[];
  // Expected, in the guild, but NOT currently holding -- actionable by "Add missing".
  missing: string[];
  // Currently holding but NOT expected -- actionable by "Remove extra".
  extra: string[];
  // Expected but not found among the guild's members at all -- the fix
  // action must skip these (nothing to add the role to).
  notInGuild: string[];
}

export interface UnmappedRole {
  roleId: string;
  roleName: string;
  holders: string[];
}

export interface RoleAuditReport {
  entries: RoleAuditEntry[];
  unmapped: UnmappedRole[];
  totals: { missing: number; extra: number };
}

// Strip emoji/pictograph/symbol ranges and collapse whitespace before a
// substring comparison, so "\u{1F3C6} Season 8 Rare 2 Champion" and "season 8
// rare 2 champion" compare equal. Deliberately simple (no full Unicode emoji
// table) -- covers the ranges Discord clients actually render as emoji in
// role names.
function normalize(s: string): string {
  return s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Find the role a division's champion should hold. A candidate must be
// non-managed, contain "champion", contain the division name, AND contain
// either "season <n>" or the season's full label (case-insensitive, emoji
// stripped). Hand-made roles that don't literally reference the season (e.g.
// "S8 Rare 2 Champion") do NOT match -- ambiguous naming is a null result,
// not a guess. Zero or multiple candidates both return null.
export function matchChampionRole(
  roles: GuildRole[],
  seasonNumber: number,
  seasonLabel: string,
  divisionName: string,
): GuildRole | null {
  const normDivision = normalize(divisionName);
  const seasonNumberToken = normalize(`season ${seasonNumber}`);
  const seasonLabelToken = normalize(seasonLabel);
  const candidates = roles.filter((r) => {
    if (r.managed) return false;
    const name = normalize(r.name);
    if (!name.includes("champion")) return false;
    if (!normDivision || !name.includes(normDivision)) return false;
    return name.includes(seasonNumberToken) || name.includes(seasonLabelToken);
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

// Per-expectation audit: who holds the role, who should but doesn't, who
// does but shouldn't, plus a list of every other guild role (managed and
// @everyone excluded) that no expectation covers -- so an admin can decide
// which extra roles (star/winner badges) need rules of their own later.
export function auditRoles(
  roles: GuildRole[],
  members: GuildMemberRoles[],
  expectations: RoleExpectation[],
  guildId: string,
): RoleAuditReport {
  const memberIds = new Set(members.map((m) => m.discordId));
  const coveredRoleIds = new Set(expectations.map((e) => e.roleId));

  let totalMissing = 0;
  let totalExtra = 0;

  const entries: RoleAuditEntry[] = expectations.map((exp) => {
    const holders = members.filter((m) => m.roles.includes(exp.roleId)).map((m) => m.discordId);
    const holderSet = new Set(holders);
    const expectedSet = new Set(exp.expected);

    const ok = exp.expected.filter((id) => holderSet.has(id));
    const missing = exp.expected.filter((id) => !holderSet.has(id) && memberIds.has(id));
    const notInGuild = exp.expected.filter((id) => !memberIds.has(id));
    const extra = holders.filter((id) => !expectedSet.has(id));

    totalMissing += missing.length + notInGuild.length;
    totalExtra += extra.length;

    return {
      roleId: exp.roleId,
      roleName: exp.roleName,
      kind: exp.kind,
      description: exp.description,
      expectedCount: exp.expected.length,
      holderCount: holders.length,
      ok,
      missing,
      extra,
      notInGuild,
    };
  });

  const unmapped: UnmappedRole[] = roles
    .filter((r) => !r.managed && r.id !== guildId && !coveredRoleIds.has(r.id))
    .map((r) => ({
      roleId: r.id,
      roleName: r.name,
      holders: members.filter((m) => m.roles.includes(r.id)).map((m) => m.discordId),
    }))
    .sort((a, b) => b.holders.length - a.holders.length);

  return {
    entries,
    unmapped,
    totals: { missing: totalMissing, extra: totalExtra },
  };
}

// ---------------------------------------------------------------------------
// Cross-season player record + the exact-count winner-role scheme.
// ---------------------------------------------------------------------------

// One player's membership in one ended-season division. Built by the shell
// from DivisionMember + cached standings; the core only groups/counts these.
export interface SeasonMembershipRecord {
  playerId: string;
  discordId: string;
  displayName: string;
  seasonNumber: number;
  seasonLabel: string;
  divisionName: string;
  tierName: string;
  tierPosition: number;
  finalGlobalRank: number | null;
  // 1-based position within the division's cached standings order; null
  // when there's no cache (or the player isn't in it).
  finish: number | null;
  // True iff this membership is the division's resolved champion (see
  // resolveDivisionChampion-style logic in the shell).
  champion: boolean;
}

export interface SeasonRecord {
  playerId: string;
  discordId: string;
  displayName: string;
  seasonsPlayed: number;
  // Total champion seasons across every tier.
  titles: number;
  // Champion seasons broken down by tier name.
  titlesByTier: Record<string, number>;
  // Every membership, sorted by season number ascending (oldest first) --
  // the shell/page renders these into the compact "S6 Rare 2 #1, ..." string.
  memberships: SeasonMembershipRecord[];
}

// Group raw memberships into one record per player. Sorted by titles
// descending, then displayName -- the TO scans for discrepancies starting
// with the most-decorated players.
export function buildSeasonRecords(entries: SeasonMembershipRecord[]): SeasonRecord[] {
  const byPlayer = new Map<string, SeasonRecord>();
  for (const e of entries) {
    let rec = byPlayer.get(e.playerId);
    if (!rec) {
      rec = {
        playerId: e.playerId,
        discordId: e.discordId,
        displayName: e.displayName,
        seasonsPlayed: 0,
        titles: 0,
        titlesByTier: {},
        memberships: [],
      };
      byPlayer.set(e.playerId, rec);
    }
    rec.seasonsPlayed += 1;
    rec.memberships.push(e);
    if (e.champion) {
      rec.titles += 1;
      rec.titlesByTier[e.tierName] = (rec.titlesByTier[e.tierName] ?? 0) + 1;
    }
  }
  const records = [...byPlayer.values()];
  for (const r of records) r.memberships.sort((a, b) => a.seasonNumber - b.seasonNumber);
  records.sort((a, b) => b.titles - a.titles || a.displayName.localeCompare(b.displayName));
  return records;
}

// Pick the tier name a role is naming, tolerating one tier name being a
// substring of another (e.g. "Common" inside "Uncommon"): if a shorter
// match is itself contained in a longer match, the longer one wins and the
// shorter is dropped as a false positive, not real ambiguity. Only genuine
// ambiguity (two unrelated tier names both present) returns null.
function findTierMatch(normalizedName: string, tierNames: string[]): string | null {
  const matched = tierNames.filter((t) => normalizedName.includes(t.toLowerCase()));
  if (matched.length === 0) return null;
  const maximal = matched.filter(
    (t) =>
      !matched.some(
        (other) => other !== t && other.length > t.length && other.toLowerCase().includes(t.toLowerCase()),
      ),
  );
  return maximal.length === 1 ? maximal[0]! : null;
}

// Count star-emoji characters anywhere in the (non-normalized) name -- the
// alternate "count written as a run of stars" form. Checked against the RAW
// name since normalize() strips these same ranges.
function countStars(raw: string): number {
  const matches = raw.match(/[\u2b50\u{1f31f}]/gu);
  return matches ? matches.length : 0;
}

// "<n>x" or "x<n>" (either order, optional space) in an already-normalized
// (lowercased) name.
function extractDigitCount(normalizedName: string): number | null {
  const m = normalizedName.match(/(\d+)\s*x\b|\bx\s*(\d+)\b/);
  if (!m) return null;
  const digits = m[1] ?? m[2];
  const n = digits ? parseInt(digits, 10) : NaN;
  return n > 0 ? n : null;
}

export interface WinnerRoleMatch {
  tierName: string;
  count: number;
}

// Parse a guild role name as a "<n>x <Tier> Winner"-style title-count role.
// Requires exactly one tier name present (see findTierMatch) AND a count,
// written either as digits ("2x"/"x2") or a run of star emoji. Null when
// either part is missing or the tier name is ambiguous.
export function parseWinnerRole(name: string, tierNames: string[]): WinnerRoleMatch | null {
  const normalized = normalize(name);
  const tierName = findTierMatch(normalized, tierNames);
  if (!tierName) return null;

  const count = extractDigitCount(normalized) ?? (countStars(name) > 0 ? countStars(name) : null);
  if (count === null) return null;

  return { tierName, count };
}

export interface MissingWinnerRole {
  tierName: string;
  count: number;
  // discordIds who have exactly this many titles in this tier.
  players: string[];
}

const WINNER_KEY_SEP = "\u0000";

// Build one RoleExpectation per guild role that parses as a winner role, and
// surface (tier, count) combos that have players but no matching role yet.
// A player with exactly N titles in a tier is expected ONLY on the "Nx
// <Tier>" role -- holding a different count's role for the same tier is an
// `extra` there and a `missing` on the correct one, via the normal
// auditRoles diff once these expectations are fed in alongside the rest.
export function buildWinnerExpectations(
  roles: GuildRole[],
  records: SeasonRecord[],
  tierNames: string[],
): { expectations: RoleExpectation[]; missingWinnerRoles: MissingWinnerRole[] } {
  const byTierCount = new Map<string, string[]>();
  for (const r of records) {
    for (const [tierName, count] of Object.entries(r.titlesByTier)) {
      if (count <= 0) continue;
      const key = `${tierName}${WINNER_KEY_SEP}${count}`;
      const existing = byTierCount.get(key);
      if (existing) existing.push(r.discordId);
      else byTierCount.set(key, [r.discordId]);
    }
  }

  const expectations: RoleExpectation[] = [];
  const consumed = new Set<string>();
  for (const role of roles) {
    if (role.managed) continue;
    const match = parseWinnerRole(role.name, tierNames);
    if (!match) continue;
    const key = `${match.tierName}${WINNER_KEY_SEP}${match.count}`;
    consumed.add(key);
    expectations.push({
      roleId: role.id,
      roleName: role.name,
      kind: "winner",
      description: `${match.count}x ${match.tierName} winner`,
      expected: byTierCount.get(key) ?? [],
    });
  }

  const missingWinnerRoles: MissingWinnerRole[] = [];
  for (const [key, players] of byTierCount) {
    if (consumed.has(key)) continue;
    const [tierName, countText] = key.split(WINNER_KEY_SEP);
    missingWinnerRoles.push({ tierName: tierName!, count: Number(countText), players });
  }
  missingWinnerRoles.sort((a, b) => a.tierName.localeCompare(b.tierName) || a.count - b.count);

  return { expectations, missingWinnerRoles };
}
