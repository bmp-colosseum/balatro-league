// Data for the admin bulk-resolve queue (/admin/resolve): every REAL scheduled
// match that's stuck -- LEAGUE_BO2 Match rows still PENDING or DISPUTED --
// across every division in the active season, classified by the pure core
// (lib/bulk-resolve-core.ts) into a row view with a suggested action, then
// filtered down to what the admin asked to see. With the 4-opponent graph
// schedule most member pairs were never meant to play, so this deliberately
// only surfaces matches that already exist as stuck Match rows, not "every
// pair without a result".

import "server-only";

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";
import {
  classifyUnresolved,
  type CheckinStatusLite,
  type DivisionMemberInput,
  type SuggestedActionKind,
  type UnresolvedRow,
} from "@/lib/bulk-resolve-core";

export type RowStatusFilter = "all" | "pending" | "disputed" | "unplayed-scheduled";

export interface BulkResolveFilters {
  divisionId?: string;
  status?: RowStatusFilter;
  suggested?: SuggestedActionKind | "all";
  olderThanDays?: number;
  droppedOnly?: boolean;
}

export interface BulkResolveDivisionOption {
  id: string;
  name: string;
  tierName: string;
}

export interface BulkResolveQueueRow extends UnresolvedRow {
  divisionName: string;
  tierName: string;
}

export interface BulkResolveData {
  hasActiveSeason: boolean;
  seasonLabel: string | null;
  divisions: BulkResolveDivisionOption[];
  rows: BulkResolveQueueRow[];
  // Count before any filter in BulkResolveFilters is applied -- lets the page
  // tell "nothing matches this filter" apart from "the queue is empty".
  totalUnfiltered: number;
}

const STATUS_WANTED: Record<Exclude<RowStatusFilter, "all">, UnresolvedRow["status"]> = {
  pending: "PENDING",
  disputed: "DISPUTED",
  "unplayed-scheduled": "UNPLAYED_SCHEDULED",
};

export async function loadBulkResolveQueue(filters: BulkResolveFilters): Promise<BulkResolveData> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, number: true, subtitle: true },
  });
  if (!season) {
    return { hasActiveSeason: false, seasonLabel: null, divisions: [], rows: [], totalUnfiltered: 0 };
  }

  const divisionsRaw = await prisma.division.findMany({
    where: { seasonId: season.id },
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
          player: { select: { displayName: true } },
        },
      },
      matches: {
        where: { format: "LEAGUE_BO2", status: { in: ["PENDING", "DISPUTED"] } },
        select: {
          id: true,
          playerAId: true,
          playerBId: true,
          status: true,
          createdAt: true,
          reportedAt: true,
          confirmedAt: true,
          disputedAt: true,
        },
      },
    },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
  });

  const divisions: BulkResolveDivisionOption[] = divisionsRaw.map((d) => ({
    id: d.id,
    name: d.name,
    tierName: d.tier.name,
  }));

  const now = new Date();
  let rows: BulkResolveQueueRow[] = divisionsRaw.flatMap((d) => {
    const members: DivisionMemberInput[] = d.members.map((m) => ({
      playerId: m.playerId,
      displayName: m.player.displayName,
      status: m.status,
      droppedAt: m.droppedAt,
      checkinStatus: m.checkinStatus as CheckinStatusLite,
      checkinAt: m.checkinAt,
    }));
    return d.matches.map((m) => {
      const row = classifyUnresolved(
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
      return { ...row, divisionName: d.name, tierName: d.tier.name };
    });
  });

  const totalUnfiltered = rows.length;

  if (filters.divisionId) rows = rows.filter((r) => r.divisionId === filters.divisionId);
  if (filters.status && filters.status !== "all") {
    const wanted = STATUS_WANTED[filters.status];
    rows = rows.filter((r) => r.status === wanted);
  }
  if (filters.suggested && filters.suggested !== "all") {
    rows = rows.filter((r) => r.suggestion.action === filters.suggested);
  }
  if (filters.olderThanDays != null && Number.isFinite(filters.olderThanDays)) {
    rows = rows.filter((r) => r.daysSinceTouch >= filters.olderThanDays!);
  }
  if (filters.droppedOnly) {
    rows = rows.filter((r) => r.playerA.memberStatus === "DROPPED" || r.playerB.memberStatus === "DROPPED");
  }

  // Stalest first -- the ones that most need an admin's attention surface at
  // the top regardless of which division they're in.
  rows = [...rows].sort((a, b) => b.daysSinceTouch - a.daysSinceTouch);

  return { hasActiveSeason: true, seasonLabel: formatSeasonLabel(season), divisions, rows, totalUnfiltered };
}
