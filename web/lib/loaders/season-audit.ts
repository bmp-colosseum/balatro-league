// Loader for /admin/season-audit: assembles the plain SeasonAuditInput the
// pure core (season-audit-core.ts) decides from, for one season or for the
// overview list across every ended season (plus the active one).
//
// Standings ALWAYS come from loadManyDivisionStandings -- never recomputed
// here. To detect a cold cache (the "standings-missing" finding) we snapshot
// which divisions already have a DivisionStandings row BEFORE calling the
// loader, since the loader itself warms any cold cache as a side effect
// (same convention as loadDivisionScoringBadge / loadDivisionUncounted).

import "server-only";

import { prisma } from "@/lib/prisma";
import { loadManyDivisionStandings } from "@/lib/standings-cache";
import { formatSeasonLabel } from "@/lib/format-season";
import {
  auditSeason,
  type SeasonAuditDivisionInput,
  type SeasonAuditInput,
  type SeasonAuditMatchFormat,
  type SeasonAuditMatchStatus,
  type SeasonAuditReport,
  type SeasonAuditStandingRowInput,
} from "@/lib/season-audit-core";

export interface SeasonAuditOverviewRow {
  seasonId: string;
  seasonLabel: string;
  ended: boolean;
  countsBySeverity: SeasonAuditReport["countsBySeverity"];
}

export interface SeasonAuditOverview {
  seasons: SeasonAuditOverviewRow[];
  // Most-recently-ended season, else the active one, else null if neither
  // exists -- the page's default selection when no ?season= is given.
  defaultSeasonId: string | null;
}

export interface SeasonAuditDivisionSummary {
  divisionId: string;
  name: string;
}

export interface SeasonAuditPageData {
  seasonId: string;
  seasonLabel: string;
  ended: boolean;
  report: SeasonAuditReport;
  // Ladder order, for grouping findings by division on the page even when a
  // division has zero findings of its own.
  divisions: SeasonAuditDivisionSummary[];
}

const SEASON_SELECT = {
  id: true,
  number: true,
  subtitle: true,
  endedAt: true,
  isActive: true,
  startedAt: true,
  leaguePlayerRoleId: true,
  discordCategoryId: true,
  divisions: {
    orderBy: [{ tier: { position: "asc" as const } }, { groupNumber: "asc" as const }],
    select: {
      id: true,
      name: true,
      groupNumber: true,
      promoteCount: true,
      relegateCount: true,
      championPlayerId: true,
      discordChannelId: true,
      discordRoleId: true,
      tier: { select: { position: true } },
      members: {
        select: {
          playerId: true,
          status: true,
          finalGlobalRank: true,
          player: { select: { displayName: true } },
        },
      },
      matches: {
        select: {
          id: true,
          format: true,
          status: true,
          playerAId: true,
          playerBId: true,
          winnerId: true,
          adminOverrideBy: true,
          gamesWonA: true,
          gamesWonB: true,
        },
      },
    },
  },
};

type SeasonForAudit = NonNullable<Awaited<ReturnType<typeof fetchSeasonForAudit>>>;

function fetchSeasonForAudit(seasonId: string) {
  return prisma.season.findUnique({ where: { id: seasonId }, select: SEASON_SELECT });
}

async function buildSeasonAuditInput(season: SeasonForAudit): Promise<SeasonAuditInput> {
  const divisionIds = season.divisions.map((d) => d.id);

  // Snapshot which divisions already had a warm cache BEFORE the read below
  // warms the rest -- that snapshot, not the post-read state, is what
  // "standings-missing" should reflect.
  const warmed = divisionIds.length === 0 ? [] : await prisma.divisionStandings.findMany({
    where: { divisionId: { in: divisionIds } },
    select: { divisionId: true },
  });
  const warmedIds = new Set(warmed.map((w) => w.divisionId));

  const standingsByDivisionId = await loadManyDivisionStandings(divisionIds);

  const divisions: SeasonAuditDivisionInput[] = season.divisions.map((d, index) => {
    const rows: SeasonAuditStandingRowInput[] | null = warmedIds.has(d.id)
      ? (standingsByDivisionId.get(d.id) ?? []).map((r) => ({
          playerId: r.player.id,
          displayName: r.player.displayName,
          rank: r.rank ?? 1,
          points: r.points,
          tiedWithPrev: r.tiedWithPrev,
          dropped: r.dropped,
        }))
      : null;

    return {
      divisionId: d.id,
      name: d.name,
      tierPosition: d.tier.position,
      groupNumber: d.groupNumber,
      promoteCount: d.promoteCount,
      relegateCount: d.relegateCount,
      isFirst: index === 0,
      isLast: index === season.divisions.length - 1,
      championPlayerId: d.championPlayerId,
      discordChannelId: d.discordChannelId,
      discordRoleId: d.discordRoleId,
      members: d.members.map((m) => ({
        playerId: m.playerId,
        displayName: m.player.displayName,
        status: m.status,
        finalGlobalRank: m.finalGlobalRank,
      })),
      rows,
      matches: d.matches.map((m) => ({
        id: m.id,
        format: m.format as SeasonAuditMatchFormat,
        status: m.status as SeasonAuditMatchStatus,
        playerAId: m.playerAId,
        playerBId: m.playerBId,
        winnerId: m.winnerId,
        adminOverrideBy: m.adminOverrideBy,
        gamesWonA: m.gamesWonA,
        gamesWonB: m.gamesWonB,
      })),
    };
  });

  return {
    seasonId: season.id,
    seasonLabel: formatSeasonLabel(season),
    ended: season.endedAt !== null,
    divisions,
    leaguePlayerRoleId: season.leaguePlayerRoleId,
    discordCategoryId: season.discordCategoryId,
  };
}

export async function loadSeasonAudit(seasonId: string): Promise<SeasonAuditPageData | null> {
  const season = await fetchSeasonForAudit(seasonId);
  if (!season) return null;
  const input = await buildSeasonAuditInput(season);
  const report = auditSeason(input);
  return {
    seasonId: input.seasonId,
    seasonLabel: input.seasonLabel,
    ended: input.ended,
    report,
    divisions: input.divisions.map((d) => ({ divisionId: d.divisionId, name: d.name })),
  };
}

export async function loadSeasonAuditOverview(): Promise<SeasonAuditOverview> {
  const seasons = await prisma.season.findMany({
    where: { OR: [{ endedAt: { not: null } }, { isActive: true }] },
    select: SEASON_SELECT,
  });

  // Same timeline ordering as /admin/seasons: active first, then ended
  // descending by endedAt (most-recently-ended first).
  const sorted = [...seasons].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const aEnd = a.endedAt?.getTime() ?? 0;
    const bEnd = b.endedAt?.getTime() ?? 0;
    if (aEnd !== bEnd) return bEnd - aEnd;
    return b.startedAt.getTime() - a.startedAt.getTime();
  });

  const rows: SeasonAuditOverviewRow[] = [];
  for (const season of sorted) {
    const input = await buildSeasonAuditInput(season);
    const report = auditSeason(input);
    rows.push({
      seasonId: input.seasonId,
      seasonLabel: input.seasonLabel,
      ended: input.ended,
      countsBySeverity: report.countsBySeverity,
    });
  }

  const defaultSeasonId = rows.find((r) => r.ended)?.seasonId ?? rows[0]?.seasonId ?? null;
  return { seasons: rows, defaultSeasonId };
}
