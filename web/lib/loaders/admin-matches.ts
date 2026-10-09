// Data for the merged admin Matches page (/admin/matches) -- the single
// surface replacing /admin/results + /admin/resolve + /admin/disputes (see
// .claude/knowledge/ux-audit/01-findings.md, "Target: three weekly pages").
//
// Gathers every Match row (any format, any status) for one season -- the
// active one, or whichever the admin picked via ?season=, falling back to
// the newest season if none is active -- across every division, classifies
// each one with the SAME pure core the old bulk-resolve queue used
// (classifyUnresolved: suggestion + per-player standing + staleness), and
// folds in display fields (division/tier label, scoreline, dispute detail)
// the old /admin/results and /admin/disputes pages each loaded separately.
//
// classifyUnresolved is total for ANY match status (CONFIRMED/CANCELLED
// degrade to its defensive "OTHER" row status, which lib/matches-page-core.ts
// maps onto this page's "Recorded" bucket) -- so one pass classifies every
// row on the page, not just the old queue's PENDING/DISPUTED subset.

import "server-only";

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";
import {
  classifyUnresolved,
  type CheckinStatusLite,
  type DivisionMemberInput,
} from "@/lib/bulk-resolve-core";
import {
  resolveSeasonId,
  toPageStatus,
  type MatchPageDispute,
  type MatchPageRow,
} from "@/lib/matches-page-core";

export interface AdminMatchesDivisionOption {
  id: string;
  name: string;
  tierName: string;
  tierPosition: number;
}

export interface AdminMatchesMember {
  playerId: string;
  displayName: string;
  discordId: string;
  username: string | null;
}

export interface AdminMatchesSeasonOption {
  id: string;
  label: string;
  isActive: boolean;
  ended: boolean;
}

export interface AdminMatchesPageData {
  hasSeason: boolean;
  seasonId: string | null;
  seasonLabel: string | null;
  seasonIsActive: boolean;
  seasons: AdminMatchesSeasonOption[];
  divisions: AdminMatchesDivisionOption[];
  // Every member, by division -- the single-match panel + shootout picker
  // need the roster for whichever division a row/action is scoped to.
  membersByDivision: Map<string, AdminMatchesMember[]>;
  rows: MatchPageRow[];
}

export async function loadAdminMatchesPage(requestedSeasonId: string | undefined): Promise<AdminMatchesPageData> {
  const seasonRows = await prisma.season.findMany({
    orderBy: [{ isActive: "desc" }, { number: "desc" }],
    select: { id: true, number: true, subtitle: true, isActive: true, endedAt: true, startedAt: true, scheduledEndAt: true },
  });
  const seasons: AdminMatchesSeasonOption[] = seasonRows.map((s) => ({
    id: s.id,
    label: formatSeasonLabel(s),
    isActive: s.isActive,
    ended: s.endedAt !== null,
  }));

  const seasonId = resolveSeasonId(
    seasonRows.map((s) => ({ id: s.id, number: s.number, isActive: s.isActive })),
    requestedSeasonId,
  );
  if (!seasonId) {
    return {
      hasSeason: false,
      seasonId: null,
      seasonLabel: null,
      seasonIsActive: false,
      seasons,
      divisions: [],
      membersByDivision: new Map(),
      rows: [],
    };
  }
  const season = seasonRows.find((s) => s.id === seasonId)!;

  const divisionsRaw = await prisma.division.findMany({
    where: { seasonId },
    select: {
      id: true,
      name: true,
      tier: { select: { name: true, position: true } },
      members: {
        select: {
          playerId: true,
          status: true,
          droppedAt: true,
          checkinStatus: true,
          checkinAt: true,
          player: { select: { displayName: true, discordId: true, username: true } },
        },
      },
      matches: {
        select: {
          id: true,
          format: true,
          playerAId: true,
          playerBId: true,
          gamesWonA: true,
          gamesWonB: true,
          status: true,
          forfeit: true,
          createdAt: true,
          reportedAt: true,
          confirmedAt: true,
          disputedAt: true,
          disputeProposedGamesWonA: true,
          disputeProposedGamesWonB: true,
          disputeProposedLivesG1: true,
          disputeProposedLivesG2: true,
          disputeReason: true,
          disputeThreadId: true,
          disputedById: true,
          reporterId: true,
          playerA: { select: { id: true, displayName: true } },
          playerB: { select: { id: true, displayName: true } },
        },
      },
    },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
  });

  const divisions: AdminMatchesDivisionOption[] = divisionsRaw.map((d) => ({
    id: d.id,
    name: d.name,
    tierName: d.tier.name,
    tierPosition: d.tier.position,
  }));

  const membersByDivision = new Map<string, AdminMatchesMember[]>();
  for (const d of divisionsRaw) {
    membersByDivision.set(
      d.id,
      d.members
        .filter((m) => m.status === "ACTIVE")
        .map((m) => ({ playerId: m.playerId, displayName: m.player.displayName, discordId: m.player.discordId, username: m.player.username })),
    );
  }

  const now = new Date();
  const rows: MatchPageRow[] = divisionsRaw.flatMap((d) => {
    const members: DivisionMemberInput[] = d.members.map((m) => ({
      playerId: m.playerId,
      displayName: m.player.displayName,
      status: m.status,
      droppedAt: m.droppedAt,
      checkinStatus: m.checkinStatus as CheckinStatusLite,
      checkinAt: m.checkinAt,
    }));
    const nameById = new Map(d.members.map((m) => [m.playerId, m.player.displayName]));

    return d.matches.map((m) => {
      const classified = classifyUnresolved(
        {
          id: m.id,
          divisionId: d.id,
          playerAId: m.playerAId,
          playerBId: m.playerBId,
          status: m.status,
          createdAt: m.createdAt,
          reportedAt: m.reportedAt,
          confirmedAt: m.confirmedAt,
          disputedAt: m.disputedAt,
        },
        members,
        now,
      );

      const dispute: MatchPageDispute | null =
        m.status === "DISPUTED"
          ? {
              proposedGamesWonA: m.disputeProposedGamesWonA,
              proposedGamesWonB: m.disputeProposedGamesWonB,
              proposedLivesG1: m.disputeProposedLivesG1,
              proposedLivesG2: m.disputeProposedLivesG2,
              reason: m.disputeReason,
              threadId: m.disputeThreadId,
              disputer: m.disputedById ? { id: m.disputedById, displayName: nameById.get(m.disputedById) ?? m.disputedById } : null,
              reporter: m.reporterId ? { id: m.reporterId, displayName: nameById.get(m.reporterId) ?? m.reporterId } : null,
            }
          : null;

      const row: MatchPageRow = {
        matchId: classified.matchId,
        divisionId: classified.divisionId,
        divisionName: d.name,
        tierName: d.tier.name,
        tierPosition: d.tier.position,
        format: m.format,
        pageStatus: toPageStatus(classified.status),
        rawStatus: classified.status,
        playerA: classified.playerA,
        playerB: classified.playerB,
        gamesWonA: m.gamesWonA,
        gamesWonB: m.gamesWonB,
        forfeit: m.forfeit,
        lastTouchedAt: classified.lastTouchedAt,
        daysSinceTouch: classified.daysSinceTouch,
        suggestion: classified.suggestion,
        dispute,
      };
      return row;
    });
  });

  return {
    hasSeason: true,
    seasonId,
    seasonLabel: formatSeasonLabel(season),
    seasonIsActive: season.isActive,
    seasons,
    divisions,
    membersByDivision,
    rows,
  };
}
