// Data for /admin/roles ("Role audit"): who SHOULD hold which league-managed
// Discord role vs who actually does, plus every other role in the server so
// the TO can decide which extras (star/winner roles) deserve rules of their
// own later. All business logic (matching, diffing, the winner-role scheme,
// cross-season records) lives in the pure core (role-audit-core.ts) -- this
// file only gathers Discord + DB state and resolves display names.

import "server-only";

import { prisma } from "@/lib/prisma";
import { listGuildRoles, listAllGuildMembers } from "@/lib/discord";
import { loadManyDivisionStandings } from "@/lib/standings-cache";
import { pickDivisionWinners } from "@/lib/loaders/admin-winners";
import { formatSeasonLabel } from "@/lib/format-season";
import type { StandingRow } from "@/lib/standings";
import {
  auditRoles,
  matchChampionRole,
  buildSeasonRecords,
  buildWinnerExpectations,
  type GuildMemberRoles,
  type MissingWinnerRole,
  type RoleAuditReport,
  type RoleExpectation,
  type SeasonMembershipRecord,
  type SeasonRecord,
} from "@/lib/role-audit-core";

export interface UnmatchedChampion {
  seasonLabel: string;
  divisionName: string;
  championName: string;
}

// A season record ready for the page: the player's cross-season history plus
// which winner-kind roles they currently hold vs should hold. Built in the
// loader (not the core) purely to attach resolved display names -- the diff
// itself (ok/missing/extra) comes straight from auditRoles's winner entries.
export interface SeasonRecordRow {
  playerId: string;
  discordId: string;
  displayName: string;
  titles: number;
  titlesByTier: Record<string, number>;
  memberships: SeasonMembershipRecord[];
  rolesHeld: string[];
  missingRoleNames: string[];
  extraRoleNames: string[];
}

export interface RoleAuditPageData {
  report: RoleAuditReport;
  // Every discordId that shows up anywhere in the report, resolved to the
  // best available display name: Player.displayName, else the guild
  // member's nick/username, else the raw id.
  displayNames: Record<string, string>;
  unmatchedChampions: UnmatchedChampion[];
  seasonRecords: SeasonRecordRow[];
  missingWinnerRoles: MissingWinnerRole[];
  // False when DISCORD_GUILD_ID isn't configured -- the page shows a
  // Callout instead of an empty report.
  guildConfigured: boolean;
}

const EMPTY_REPORT: RoleAuditReport = { entries: [], unmapped: [], totals: { missing: 0, extra: 0 } };

export async function loadRoleAuditData(): Promise<RoleAuditPageData> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    return {
      report: EMPTY_REPORT,
      displayNames: {},
      unmatchedChampions: [],
      seasonRecords: [],
      missingWinnerRoles: [],
      guildConfigured: false,
    };
  }

  const [discordRoles, discordMembers, activeSeason, endedSeasons] = await Promise.all([
    listGuildRoles(guildId),
    listAllGuildMembers(guildId),
    loadActiveSeasonForAudit(),
    loadEndedSeasonsForAudit(),
  ]);

  const members: GuildMemberRoles[] = discordMembers.map((m) => ({
    discordId: m.id,
    roles: m.roles,
    label: m.nick ?? m.username,
  }));
  const roleNameById = new Map(discordRoles.map((r) => [r.id, r.name]));

  // Resolved as we build expectations -- fed into the final display-name
  // lookup so the page never shows a bare discord id for anyone the DB
  // already knows about.
  const playerNameByDiscordId = new Map<string, string>();
  const playerById = new Map<string, { id: string; discordId: string; displayName: string }>();

  const expectations: RoleExpectation[] = [];

  if (activeSeason?.leaguePlayerRoleId) {
    const seasonLabel = formatSeasonLabel(activeSeason);
    const rosterIds = new Set<string>();
    for (const div of activeSeason.divisions) {
      for (const mem of div.members) {
        rosterIds.add(mem.player.discordId);
        playerNameByDiscordId.set(mem.player.discordId, mem.player.displayName);
      }
    }
    expectations.push({
      roleId: activeSeason.leaguePlayerRoleId,
      roleName: roleNameById.get(activeSeason.leaguePlayerRoleId) ?? "League Player (role not found)",
      kind: "league-player",
      description: `Active roster for ${seasonLabel}`,
      expected: [...rosterIds],
    });

    for (const div of activeSeason.divisions) {
      for (const mem of div.members) playerNameByDiscordId.set(mem.player.discordId, mem.player.displayName);
      if (!div.discordRoleId) continue;
      expectations.push({
        roleId: div.discordRoleId,
        roleName: roleNameById.get(div.discordRoleId) ?? div.name,
        kind: "division",
        description: `${div.name} roster for ${seasonLabel}`,
        expected: div.members.map((mem) => mem.player.discordId),
      });
    }
  }

  for (const s of endedSeasons) {
    for (const d of s.divisions) {
      for (const mem of d.members) playerById.set(mem.player.id, mem.player);
    }
  }
  const explicitChampionIds = new Set<string>();
  for (const s of endedSeasons) {
    for (const d of s.divisions) {
      if (d.championPlayerId && !playerById.has(d.championPlayerId)) explicitChampionIds.add(d.championPlayerId);
    }
  }
  if (explicitChampionIds.size > 0) {
    const extraPlayers = await prisma.player.findMany({
      where: { id: { in: [...explicitChampionIds] } },
      select: { id: true, discordId: true, displayName: true },
    });
    for (const p of extraPlayers) playerById.set(p.id, p);
  }

  const endedDivisionIds = endedSeasons.flatMap((s) => s.divisions.map((d) => d.id));
  const standingsByDivision = await loadManyDivisionStandings(endedDivisionIds);

  const unmatchedChampions: UnmatchedChampion[] = [];
  const membershipRecords: SeasonMembershipRecord[] = [];
  const allTierNames = new Set<string>();

  for (const s of endedSeasons) {
    const seasonLabel = formatSeasonLabel(s);
    for (const d of s.divisions) {
      allTierNames.add(d.tier.name);
      const rows = standingsByDivision.get(d.id) ?? [];
      const championPlayerId = resolveDivisionChampionId(d.championPlayerId, rows);

      for (const mem of d.members) {
        const finishIndex = rows.findIndex((r) => r.player.id === mem.player.id);
        membershipRecords.push({
          playerId: mem.player.id,
          discordId: mem.player.discordId,
          displayName: mem.player.displayName,
          seasonNumber: s.number,
          seasonLabel,
          divisionName: d.name,
          tierName: d.tier.name,
          tierPosition: d.tier.position,
          finalGlobalRank: mem.finalGlobalRank,
          finish: finishIndex === -1 ? null : finishIndex + 1,
          champion: championPlayerId === mem.player.id,
        });
      }

      if (!championPlayerId) continue;
      const champ = playerById.get(championPlayerId);
      if (!champ) continue;
      playerNameByDiscordId.set(champ.discordId, champ.displayName);

      const role = matchChampionRole(discordRoles, s.number, seasonLabel, d.name);
      if (!role) {
        unmatchedChampions.push({ seasonLabel, divisionName: d.name, championName: champ.displayName });
        continue;
      }
      expectations.push({
        roleId: role.id,
        roleName: role.name,
        kind: "champion",
        description: `${d.name} champion, ${seasonLabel}`,
        expected: [champ.discordId],
      });
    }
  }

  const seasonRecords: SeasonRecord[] = buildSeasonRecords(membershipRecords);
  const { expectations: winnerExpectations, missingWinnerRoles } = buildWinnerExpectations(
    discordRoles,
    seasonRecords,
    [...allTierNames],
  );
  expectations.push(...winnerExpectations);
  for (const r of seasonRecords) playerNameByDiscordId.set(r.discordId, r.displayName);

  const report = auditRoles(discordRoles, members, expectations, guildId);

  const memberLabelByDiscordId = new Map(members.map((m) => [m.discordId, m.label]));
  const idsNeedingNames = new Set<string>();
  for (const e of report.entries) {
    for (const id of e.ok) idsNeedingNames.add(id);
    for (const id of e.missing) idsNeedingNames.add(id);
    for (const id of e.extra) idsNeedingNames.add(id);
    for (const id of e.notInGuild) idsNeedingNames.add(id);
  }
  for (const u of report.unmapped) {
    for (const id of u.holders) idsNeedingNames.add(id);
  }
  for (const m of missingWinnerRoles) {
    for (const id of m.players) idsNeedingNames.add(id);
  }

  const displayNames: Record<string, string> = {};
  for (const id of idsNeedingNames) {
    displayNames[id] = playerNameByDiscordId.get(id) ?? memberLabelByDiscordId.get(id) ?? id;
  }

  const seasonRecordRows = buildSeasonRecordRows(seasonRecords, report).map((row) => ({
    ...row,
    displayName: displayNames[row.discordId] ?? playerNameByDiscordId.get(row.discordId) ?? row.displayName,
  }));

  return {
    report,
    displayNames,
    unmatchedChampions,
    seasonRecords: seasonRecordRows,
    missingWinnerRoles,
    guildConfigured: true,
  };
}

// Prefer the admin-recorded championPlayerId; fall back to the unique
// rank-1 finisher of the cached standings. A real tie at #1, or no matches
// played, means there's no champion yet for this division (not an error --
// just nothing to check).
function resolveDivisionChampionId(championPlayerId: string | null, standings: StandingRow[]): string | null {
  if (championPlayerId) return championPlayerId;
  const hasPlayed = standings.some((r) => r.played > 0);
  if (!hasPlayed) return null;
  const winners = pickDivisionWinners(standings);
  return winners.length === 1 ? winners[0]!.player.id : null;
}

// Cross-reference each player's season record with the winner-kind entries
// in the already-computed report to attach "roles currently held" and the
// missing/extra flags -- kept in the loader (not the core) only because it
// needs nothing but data already produced by auditRoles; see
// role-audit-core.ts for the actual diffing logic.
function buildSeasonRecordRows(records: SeasonRecord[], report: RoleAuditReport): SeasonRecordRow[] {
  const winnerEntries = report.entries.filter((e) => e.kind === "winner");

  const rolesHeldBy = new Map<string, string[]>();
  const missingBy = new Map<string, string[]>();
  const extraBy = new Map<string, string[]>();
  const pushInto = (map: Map<string, string[]>, key: string, value: string) => {
    const arr = map.get(key);
    if (arr) arr.push(value);
    else map.set(key, [value]);
  };
  for (const entry of winnerEntries) {
    for (const id of entry.ok) pushInto(rolesHeldBy, id, entry.roleName);
    for (const id of entry.extra) {
      pushInto(rolesHeldBy, id, entry.roleName);
      pushInto(extraBy, id, entry.roleName);
    }
    for (const id of entry.missing) pushInto(missingBy, id, entry.roleName);
    for (const id of entry.notInGuild) pushInto(missingBy, id, entry.roleName);
  }

  const rowsByDiscordId = new Map<string, SeasonRecordRow>();
  for (const r of records) {
    rowsByDiscordId.set(r.discordId, {
      playerId: r.playerId,
      discordId: r.discordId,
      displayName: r.displayName,
      titles: r.titles,
      titlesByTier: r.titlesByTier,
      memberships: r.memberships,
      rolesHeld: rolesHeldBy.get(r.discordId) ?? [],
      missingRoleNames: missingBy.get(r.discordId) ?? [],
      extraRoleNames: extraBy.get(r.discordId) ?? [],
    });
  }

  // A guild member holding a winner-looking role with NO season history at
  // all is its own anomaly worth surfacing (role without any title).
  for (const entry of winnerEntries) {
    for (const id of [...entry.ok, ...entry.extra]) {
      if (rowsByDiscordId.has(id)) continue;
      rowsByDiscordId.set(id, {
        playerId: id,
        discordId: id,
        displayName: id,
        titles: 0,
        titlesByTier: {},
        memberships: [],
        rolesHeld: rolesHeldBy.get(id) ?? [],
        missingRoleNames: missingBy.get(id) ?? [],
        extraRoleNames: extraBy.get(id) ?? [],
      });
    }
  }

  const rows = [...rowsByDiscordId.values()].filter((r) => r.titles > 0 || r.rolesHeld.length > 0);
  rows.sort((a, b) => {
    const aFlagged = a.missingRoleNames.length > 0 || a.extraRoleNames.length > 0;
    const bFlagged = b.missingRoleNames.length > 0 || b.extraRoleNames.length > 0;
    if (aFlagged !== bFlagged) return aFlagged ? -1 : 1;
    return b.titles - a.titles || a.displayName.localeCompare(b.displayName);
  });
  return rows;
}

async function loadActiveSeasonForAudit() {
  return prisma.season.findFirst({
    where: { isActive: true },
    select: {
      number: true,
      subtitle: true,
      leaguePlayerRoleId: true,
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        select: {
          name: true,
          discordRoleId: true,
          members: {
            where: { status: "ACTIVE" },
            select: { player: { select: { discordId: true, displayName: true } } },
          },
        },
      },
    },
  });
}

async function loadEndedSeasonsForAudit() {
  return prisma.season.findMany({
    where: { endedAt: { not: null } },
    select: {
      number: true,
      subtitle: true,
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        select: {
          id: true,
          name: true,
          championPlayerId: true,
          tier: { select: { name: true, position: true } },
          members: {
            where: { status: "ACTIVE" },
            select: {
              finalGlobalRank: true,
              player: { select: { id: true, discordId: true, displayName: true } },
            },
          },
        },
      },
    },
  });
}
