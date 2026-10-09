// Pure core for the merged admin Matches page (/admin/matches). Zero prisma/
// react/Date.now() imports -- every effect (loading matches/members/seasons,
// writing results) stays in the shell (lib/loaders/admin-matches.ts +
// lib/match-admin.ts + lib/bulk-resolve.ts). Three jobs:
//
//   1. resolveSeasonId -- which season's matches to show: the one the admin
//      asked for (?season=), else the active season, else the newest ended
//      one (so the page never comes up empty just because no season is
//      currently active).
//   2. toPageStatus / filterMatchRows -- map each match's underlying
//      bulk-resolve RowStatus onto this page's five-way filter (Pending /
//      Disputed / Unplayed / Recorded / All) and apply the division /
//      older-than / dropped-player filters on top.
//   3. groupMatchRows -- order rows into display groups (most-actionable
//      status first, stalest-first within an unresolved group, most-recent-
//      first within Recorded).
//
// Reuses lib/bulk-resolve-core.ts's classifyUnresolved/PlayerStanding/
// Suggestion/RowStatus wholesale for the suggestion + standing + staleness
// math (never a parallel reimplementation) -- this module only adds the
// cross-cutting "one page, five statuses, one filter bar" layer on top.

import type { PlayerStanding, RowStatus, Suggestion, UnresolvedRow } from "@/lib/bulk-resolve-core";

export type { PlayerStanding, Suggestion } from "@/lib/bulk-resolve-core";

// ---------------------------------------------------------------------------
// Status mapping -- RowStatus (bulk-resolve-core's 4-way) -> this page's 5-way
// filter vocabulary. OTHER (already CONFIRMED/CANCELLED) becomes "Recorded".

export type MatchPageStatus = "PENDING" | "DISPUTED" | "UNPLAYED_SCHEDULED" | "RECORDED";

export type StatusFilter = "all" | "pending" | "disputed" | "unplayed" | "recorded";

const STATUS_FILTER_VALUES: readonly StatusFilter[] = ["all", "pending", "disputed", "unplayed", "recorded"];

export function isStatusFilter(value: string | undefined): value is StatusFilter {
  return value != null && (STATUS_FILTER_VALUES as readonly string[]).includes(value);
}

export function parseStatusFilter(value: string | undefined): StatusFilter {
  return isStatusFilter(value) ? value : "all";
}

// Older-than-N-days query param -> a non-negative integer, or undefined for
// "no filter". Anything not a finite non-negative number is treated as unset
// rather than throwing, matching every other admin filter parser in this app.
export function parseOlderThanDays(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export function toPageStatus(status: RowStatus): MatchPageStatus {
  return status === "OTHER" ? "RECORDED" : status;
}

const FILTER_TO_PAGE_STATUS: Record<Exclude<StatusFilter, "all">, MatchPageStatus> = {
  pending: "PENDING",
  disputed: "DISPUTED",
  unplayed: "UNPLAYED_SCHEDULED",
  recorded: "RECORDED",
};

export function matchesStatusFilter(pageStatus: MatchPageStatus, filter: StatusFilter): boolean {
  return filter === "all" || pageStatus === FILTER_TO_PAGE_STATUS[filter];
}

// ---------------------------------------------------------------------------
// Row -- plain data the loader hands this core. Built from classifyUnresolved
// plus the display-only fields (names/division labels/scorelines) that
// classification itself doesn't carry. daysSinceTouch is precomputed by the
// loader (via classifyUnresolved, given one injected `now`) -- this core
// never reads a clock.

export interface MatchPageDispute {
  proposedGamesWonA: number | null;
  proposedGamesWonB: number | null;
  proposedLivesG1: number | null;
  proposedLivesG2: number | null;
  reason: string | null;
  threadId: string | null;
  disputer: { id: string; displayName: string } | null;
  reporter: { id: string; displayName: string } | null;
}

export interface MatchPageRow {
  matchId: string;
  divisionId: string;
  divisionName: string;
  tierName: string;
  tierPosition: number;
  format: string;
  pageStatus: MatchPageStatus;
  // The underlying classifyUnresolved status this row came from (OTHER for
  // anything already CONFIRMED/CANCELLED) -- kept alongside pageStatus so
  // toUnresolvedRow() below can hand a row straight to planBulkAction without
  // the page re-deriving it.
  rawStatus: RowStatus;
  playerA: PlayerStanding;
  playerB: PlayerStanding;
  gamesWonA: number;
  gamesWonB: number;
  forfeit: boolean;
  lastTouchedAt: Date;
  daysSinceTouch: number;
  suggestion: Suggestion;
  dispute: MatchPageDispute | null;
}

// Projects a page row back to the plain UnresolvedRow shape
// lib/bulk-resolve-core.ts's planBulkAction (and lib/bulk-resolve.ts's
// applyBulkResolve, via its own independent reload) expect -- so the bulk
// preview/apply flow keeps using that core unchanged, over this page's
// superset row type.
export function toUnresolvedRow(row: MatchPageRow): UnresolvedRow {
  return {
    matchId: row.matchId,
    divisionId: row.divisionId,
    status: row.rawStatus,
    playerA: row.playerA,
    playerB: row.playerB,
    lastTouchedAt: row.lastTouchedAt,
    daysSinceTouch: row.daysSinceTouch,
    suggestion: row.suggestion,
  };
}

// ---------------------------------------------------------------------------
// Filters

export interface MatchPageFilters {
  divisionId?: string;
  status: StatusFilter;
  olderThanDays?: number;
  droppedOnly: boolean;
}

export function involvesDroppedPlayer(row: Pick<MatchPageRow, "playerA" | "playerB">): boolean {
  return row.playerA.memberStatus === "DROPPED" || row.playerB.memberStatus === "DROPPED";
}

// Deterministic, order-independent: depends only on each row's own fields and
// the filter values -- never on another row's state or position in the array.
export function filterMatchRows(rows: readonly MatchPageRow[], filters: MatchPageFilters): MatchPageRow[] {
  return rows.filter((row) => {
    if (filters.divisionId && row.divisionId !== filters.divisionId) return false;
    if (!matchesStatusFilter(row.pageStatus, filters.status)) return false;
    if (filters.olderThanDays != null && row.daysSinceTouch < filters.olderThanDays) return false;
    if (filters.droppedOnly && !involvesDroppedPlayer(row)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Grouping -- fixed priority order, stalest-first within the unresolved
// groups (same convention as the old bulk-resolve queue), most-recent-first
// within Recorded. Every row appears in exactly one group; empty groups are
// omitted so the page doesn't render a heading with nothing under it.

const GROUP_ORDER: readonly MatchPageStatus[] = ["DISPUTED", "PENDING", "UNPLAYED_SCHEDULED", "RECORDED"];

export interface MatchPageGroup {
  status: MatchPageStatus;
  rows: MatchPageRow[];
}

function sortWithinGroup(status: MatchPageStatus, rows: MatchPageRow[]): MatchPageRow[] {
  const sorted = [...rows];
  if (status === "RECORDED") {
    sorted.sort((a, b) => a.daysSinceTouch - b.daysSinceTouch || a.matchId.localeCompare(b.matchId));
  } else {
    sorted.sort((a, b) => b.daysSinceTouch - a.daysSinceTouch || a.matchId.localeCompare(b.matchId));
  }
  return sorted;
}

export function groupMatchRows(rows: readonly MatchPageRow[]): MatchPageGroup[] {
  const byStatus = new Map<MatchPageStatus, MatchPageRow[]>();
  for (const row of rows) {
    const list = byStatus.get(row.pageStatus) ?? [];
    list.push(row);
    byStatus.set(row.pageStatus, list);
  }
  return GROUP_ORDER.filter((status) => (byStatus.get(status)?.length ?? 0) > 0).map((status) => ({
    status,
    rows: sortWithinGroup(status, byStatus.get(status)!),
  }));
}

// ---------------------------------------------------------------------------
// Season fallback -- "current season's matches (fall back to the latest
// season when none is active)". Pure: given the season list (plain data the
// shell already fetched) and an optional requested id, decide which one wins.

export interface SeasonOption {
  id: string;
  number: number;
  isActive: boolean;
}

export function resolveSeasonId(seasons: readonly SeasonOption[], requestedSeasonId: string | undefined): string | null {
  if (requestedSeasonId) {
    const requested = seasons.find((s) => s.id === requestedSeasonId);
    if (requested) return requested.id;
  }
  const active = seasons.find((s) => s.isActive);
  if (active) return active.id;
  if (seasons.length === 0) return null;
  return seasons.reduce((latest, s) => (s.number > latest.number ? s : latest), seasons[0]!).id;
}
