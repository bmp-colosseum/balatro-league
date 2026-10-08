// Pure core for /admin/season-audit -- read-only checks that a TO can run
// against an ENDED season (or the active one) to confirm everything was
// closed out properly: no open matches, ties resolved, champions recorded,
// final ranks consistent with the cached standings, Discord leftovers
// cleaned. Every check is a small pure function composed by auditSeason;
// none of them touch Prisma or the clock -- the shell (season-audit loader)
// gathers the plain SeasonAuditInput and this file makes every decision.
//
// A finding is surfaced even when it no longer affects anything (e.g. a
// shootout between two players who turned out not to be tied) -- that is
// the point of an audit trail, not a bug.

export type FindingSeverity = "error" | "warn" | "info";

export interface Finding {
  severity: FindingSeverity;
  code: string;
  divisionId?: string;
  divisionName?: string;
  message: string;
  href?: string;
}

export type DivisionMemberStatus = "ACTIVE" | "DROPPED";

export interface SeasonAuditMemberInput {
  playerId: string;
  displayName: string;
  status: DivisionMemberStatus;
  finalGlobalRank: number | null;
}

// Minimal projection of a cached standings row -- rank is always set once
// assignRanks has run (see web/lib/standings.ts), so it is required here
// even though StandingRow.rank itself is optional on the richer type.
export interface SeasonAuditStandingRowInput {
  playerId: string;
  displayName: string;
  rank: number;
  points: number;
  tiedWithPrev?: boolean;
  dropped?: boolean;
}

export type SeasonAuditMatchFormat = "LEAGUE_BO2" | "SHOOTOUT_BO1";
export type SeasonAuditMatchStatus = "PENDING" | "CONFIRMED" | "DISPUTED" | "CANCELLED";

export interface SeasonAuditMatchInput {
  id: string;
  format: SeasonAuditMatchFormat;
  status: SeasonAuditMatchStatus;
  playerAId: string;
  playerBId: string;
  winnerId: string | null;
  adminOverrideBy: string | null;
  gamesWonA: number;
  gamesWonB: number;
  // Set on every shootout an admin records (web/lib/match-admin.ts's
  // recordShowdown / resolveTieWithShowdowns), as opposed to a
  // player-reported one. checkShootoutDangling skips these:
  // resolveTieWithShowdowns deliberately writes a pairwise result for every
  // pair in a tied group, including pairs that land on different points once
  // the group's OTHER members' results come in, so "not tied on points" is
  // expected there, not a sign of anything dangling.
  recordedBy: string | null;
}

export interface SeasonAuditDivisionInput {
  divisionId: string;
  name: string;
  tierPosition: number;
  groupNumber: number;
  promoteCount: number;
  relegateCount: number;
  // Ladder position, honoring the same "top division never promotes / bottom
  // never relegates" rule as web/lib/loaders/standings.ts -- mirrored here
  // rather than recomputed from tierPosition/groupNumber so this core never
  // needs the full ladder, just the one bit it needs per division.
  isFirst: boolean;
  isLast: boolean;
  championPlayerId: string | null;
  discordChannelId: string | null;
  discordRoleId: string | null;
  members: SeasonAuditMemberInput[];
  // null = standings cache has never been warmed for this division.
  rows: SeasonAuditStandingRowInput[] | null;
  matches: SeasonAuditMatchInput[];
}

export interface SeasonAuditInput {
  seasonId: string;
  seasonLabel: string;
  ended: boolean;
  divisions: SeasonAuditDivisionInput[];
  leaguePlayerRoleId: string | null;
  discordCategoryId: string | null;
}

export interface SeasonAuditReport {
  findings: Finding[];
  countsBySeverity: Record<FindingSeverity, number>;
}

function activePlayerIdSet(division: SeasonAuditDivisionInput): Set<string> {
  return new Set(division.members.filter((m) => m.status === "ACTIVE").map((m) => m.playerId));
}

function displayNameOf(division: SeasonAuditDivisionInput, playerId: string): string {
  return division.members.find((m) => m.playerId === playerId)?.displayName ?? playerId;
}

// open-match (error, ended only): a LEAGUE_BO2 match still PENDING/DISPUTED
// between two currently-ACTIVE members once the season has ended -- the
// pairing was never resolved before the books closed. Not flagged on an
// active season, where an unplayed match is just normal in-progress play.
export function checkOpenMatches(division: SeasonAuditDivisionInput, ended: boolean): Finding[] {
  if (!ended) return [];
  const active = activePlayerIdSet(division);
  const findings: Finding[] = [];
  for (const m of division.matches) {
    if (m.format !== "LEAGUE_BO2") continue;
    if (m.status !== "PENDING" && m.status !== "DISPUTED") continue;
    if (!active.has(m.playerAId) || !active.has(m.playerBId)) continue;
    findings.push({
      severity: "error",
      code: "open-match",
      divisionId: division.divisionId,
      divisionName: division.name,
      message: `Open match (${m.status}) between ${displayNameOf(division, m.playerAId)} and ${displayNameOf(division, m.playerBId)} was never resolved`,
      href: "/admin/resolve",
    });
  }
  return findings;
}

// unsettled-cancel (warn): a CANCELLED LEAGUE_BO2 between two ACTIVE members
// with no adminOverrideBy -- a void that was never attributed to an admin
// decision. Harmless if intentional, but worth a second look either way.
export function checkUnsettledCancels(division: SeasonAuditDivisionInput): Finding[] {
  const active = activePlayerIdSet(division);
  const findings: Finding[] = [];
  for (const m of division.matches) {
    if (m.format !== "LEAGUE_BO2") continue;
    if (m.status !== "CANCELLED") continue;
    if (m.adminOverrideBy !== null) continue;
    if (!active.has(m.playerAId) || !active.has(m.playerBId)) continue;
    findings.push({
      severity: "warn",
      code: "unsettled-cancel",
      divisionId: division.divisionId,
      divisionName: division.name,
      message: `Cancelled match between ${displayNameOf(division, m.playerAId)} and ${displayNameOf(division, m.playerBId)} has no recorded admin reason`,
      href: "/admin/resolve",
    });
  }
  return findings;
}

// tie-on-line (error) / tie-elsewhere (info): adjacent standings rows tied
// on points. A tie is "on the line" when it includes rank 1, or straddles a
// promotion/relegation boundary -- the SAME zone math as
// web/lib/loaders/standings.ts (promote/relegate counts, capped to size,
// zeroed at the top/bottom of the whole ladder).
export function checkTies(division: SeasonAuditDivisionInput): Finding[] {
  const rows = division.rows;
  if (!rows) return [];
  const active = rows.filter((r) => !r.dropped);
  const size = active.length;
  const promote = division.isFirst ? 0 : Math.min(division.promoteCount, size);
  const relegate = division.isLast ? 0 : Math.min(division.relegateCount, size);

  const findings: Finding[] = [];
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1]!;
    const cur = active[i]!;
    if (!cur.tiedWithPrev) continue;

    const posPrev = i; // 1-indexed position of prev
    const posCur = i + 1;
    const includesRankOne = posPrev === 1;
    // A tie for #1 that the TO settled by recording the champion is resolved.
    if (includesRankOne && division.championPlayerId !== null) continue;
    const straddlesPromotion = promote > 0 && posPrev === promote && posCur === promote + 1;
    const straddlesRelegation = relegate > 0 && posPrev === size - relegate && posCur === size - relegate + 1;
    const critical = includesRankOne || straddlesPromotion || straddlesRelegation;

    const line = includesRankOne ? "#1" : straddlesPromotion ? "the promotion line" : "the relegation line";
    findings.push({
      severity: critical ? "error" : "info",
      code: critical ? "tie-on-line" : "tie-elsewhere",
      divisionId: division.divisionId,
      divisionName: division.name,
      message: critical
        ? `Tie for ${line} between ${prev.displayName} and ${cur.displayName} unresolved -- record a shootout${includesRankOne ? " or set the champion on the winners page" : ""}`
        : `Tie between ${prev.displayName} and ${cur.displayName} stands (no effect on promotion/relegation)`,
      href: `/divisions/${division.divisionId}`,
    });
  }
  return findings;
}

// no-champion (warn, ended only) / champion-mismatch (error): the ended
// season's rank-1 finisher(s) should match Division.championPlayerId. A
// division with a UNIQUE #1 and no recorded champion is fine -- every reader
// (hall of fame, winners page, role audit) derives the champion from the
// standings in that case; only a tie at the top needs the TO's call.
export function checkChampion(division: SeasonAuditDivisionInput, ended: boolean, seasonId: string): Finding[] {
  if (!ended) return [];
  const rows = division.rows;
  if (!rows || rows.length === 0) return [];
  const active = rows.filter((r) => !r.dropped);
  if (active.length === 0) return [];
  const href = `/admin/seasons/${seasonId}/winners`;

  const topRank = active[0]!.rank;
  const winners = active.filter((r) => r.rank === topRank);
  if (division.championPlayerId === null) {
    if (winners.length < 2) return [];
    return [{
      severity: "warn",
      code: "no-champion",
      divisionId: division.divisionId,
      divisionName: division.name,
      message: `Tie for #1 in ${division.name} and no champion recorded -- pick the winner on the winners page`,
      href,
    }];
  }

  if (winners.some((w) => w.playerId === division.championPlayerId)) return [];

  return [{
    severity: "error",
    code: "champion-mismatch",
    divisionId: division.divisionId,
    divisionName: division.name,
    message: `Recorded champion for ${division.name} is not the current rank-1 finisher`,
    href,
  }];
}

// Builds a playerId -> tie-group index from members sorted ascending by
// finalGlobalRank, where consecutive members sharing the same rank land in
// the same group (so their relative order is interchangeable). Pure helper
// for checkFinalRanks' rank-order check.
function rankGroupsByPlayerId(members: SeasonAuditMemberInput[]): Map<string, number> {
  const ranked = members
    .filter((m): m is SeasonAuditMemberInput & { finalGlobalRank: number } => m.finalGlobalRank !== null)
    .slice()
    .sort((a, b) => a.finalGlobalRank - b.finalGlobalRank);
  const groupOf = new Map<string, number>();
  let group = 0;
  ranked.forEach((m, i) => {
    if (i > 0 && m.finalGlobalRank !== ranked[i - 1]!.finalGlobalRank) group++;
    groupOf.set(m.playerId, group);
  });
  return groupOf;
}

// rank-missing (warn, ended only) / rank-order (error, ended only): every
// ACTIVE member should have a finalGlobalRank once the season ended, and
// the order those ranks imply should agree with the cached standings order
// (ties in finalGlobalRank are allowed to appear in either order).
export function checkFinalRanks(division: SeasonAuditDivisionInput, ended: boolean, seasonId: string): Finding[] {
  if (!ended) return [];
  const findings: Finding[] = [];
  const activeMembers = division.members.filter((m) => m.status === "ACTIVE");

  for (const m of activeMembers) {
    if (m.finalGlobalRank === null) {
      findings.push({
        severity: "warn",
        code: "rank-missing",
        divisionId: division.divisionId,
        divisionName: division.name,
        message: `${m.displayName} has no final global rank recorded`,
        href: `/admin/seasons/${seasonId}/end`,
      });
    }
  }

  if (division.rows) {
    const groupOf = rankGroupsByPlayerId(activeMembers);
    const rowOrder = division.rows
      .filter((r) => !r.dropped)
      .map((r) => r.playerId)
      .filter((id) => groupOf.has(id));

    let lastGroup = -1;
    let agrees = true;
    for (const id of rowOrder) {
      const g = groupOf.get(id)!;
      if (g < lastGroup) {
        agrees = false;
        break;
      }
      lastGroup = g;
    }
    if (!agrees) {
      findings.push({
        severity: "error",
        code: "rank-order",
        divisionId: division.divisionId,
        divisionName: division.name,
        message: `Final global rank order for ${division.name} disagrees with the standings order`,
        href: `/divisions/${division.divisionId}`,
      });
    }
  }

  return findings;
}

// standings-missing (warn): the cache was never warmed for this division --
// every rank/tie/champion check above is skipped for it as a result.
export function checkStandingsMissing(division: SeasonAuditDivisionInput): Finding[] {
  if (division.rows !== null) return [];
  return [{
    severity: "warn",
    code: "standings-missing",
    divisionId: division.divisionId,
    divisionName: division.name,
    message: `No cached standings for ${division.name} -- rank/tie/champion checks were skipped`,
    href: `/divisions/${division.divisionId}`,
  }];
}

// discord-leftover (info, ended only): division channel/role still exist
// after the season ended.
export function checkDivisionDiscordLeftovers(division: SeasonAuditDivisionInput, ended: boolean, seasonId: string): Finding[] {
  if (!ended) return [];
  const findings: Finding[] = [];
  const href = `/admin/seasons/${seasonId}`;
  if (division.discordChannelId) {
    findings.push({
      severity: "info",
      code: "discord-leftover",
      divisionId: division.divisionId,
      divisionName: division.name,
      message: `Division Discord channel still exists for ${division.name}`,
      href,
    });
  }
  if (division.discordRoleId) {
    findings.push({
      severity: "info",
      code: "discord-leftover",
      divisionId: division.divisionId,
      divisionName: division.name,
      message: `Division Discord role still exists for ${division.name}`,
      href,
    });
  }
  return findings;
}

// discord-leftover (info, ended only): season-level category/role still
// exist after the season ended.
export function checkSeasonDiscordLeftovers(input: SeasonAuditInput): Finding[] {
  if (!input.ended) return [];
  const findings: Finding[] = [];
  const href = `/admin/seasons/${input.seasonId}`;
  if (input.discordCategoryId) {
    findings.push({
      severity: "info",
      code: "discord-leftover",
      message: `Season Discord category still exists for ${input.seasonLabel}`,
      href,
    });
  }
  // The season's "League Player" role is deliberately NOT a leftover: it is one
  // shared server role that end-season strips from members and keeps for the
  // next season's bootstrap (see teardownSeasonDiscord in end-season.ts).
  return findings;
}

// shootout-dangling (info): a CONFIRMED shootout between two players who
// turned out NOT to be tied on points (same cached rank). Harmless --
// informational only, since the result still stands either way. Skips any
// shootout an admin recorded (recordedBy set) -- resolveTieWithShowdowns
// deliberately writes one per pair across a whole tied group, including
// pairs that land on different points, so those are never "dangling".
export function checkShootoutDangling(division: SeasonAuditDivisionInput): Finding[] {
  const rows = division.rows;
  if (!rows) return [];
  // Compare POINTS, not rank: a shootout that did its job leaves the two players
  // on equal points but different ranks, which is exactly the healthy case.
  const pointsByPlayerId = new Map(rows.filter((r) => !r.dropped).map((r) => [r.playerId, r.points]));
  const findings: Finding[] = [];
  for (const m of division.matches) {
    if (m.format !== "SHOOTOUT_BO1" || m.status !== "CONFIRMED") continue;
    if (m.recordedBy !== null) continue;
    const pointsA = pointsByPlayerId.get(m.playerAId);
    const pointsB = pointsByPlayerId.get(m.playerBId);
    if (pointsA === undefined || pointsB === undefined) continue;
    if (pointsA === pointsB) continue;
    findings.push({
      severity: "info",
      code: "shootout-dangling",
      divisionId: division.divisionId,
      divisionName: division.name,
      message: `Shootout between ${displayNameOf(division, m.playerAId)} and ${displayNameOf(division, m.playerBId)} recorded, but they are not tied on points`,
      href: `/divisions/${division.divisionId}`,
    });
  }
  return findings;
}

function countBySeverity(findings: Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

// Composes every check above over every division (plus the season-level
// Discord check) into one report. Order of findings is division order,
// then check order within a division -- deterministic for a given input.
export function auditSeason(input: SeasonAuditInput): SeasonAuditReport {
  const findings: Finding[] = [];
  for (const division of input.divisions) {
    findings.push(...checkOpenMatches(division, input.ended));
    findings.push(...checkUnsettledCancels(division));
    findings.push(...checkTies(division));
    findings.push(...checkChampion(division, input.ended, input.seasonId));
    findings.push(...checkFinalRanks(division, input.ended, input.seasonId));
    findings.push(...checkStandingsMissing(division));
    findings.push(...checkDivisionDiscordLeftovers(division, input.ended, input.seasonId));
    findings.push(...checkShootoutDangling(division));
  }
  findings.push(...checkSeasonDiscordLeftovers(input));
  return { findings, countsBySeverity: countBySeverity(findings) };
}
