// Pure core for the admin bulk-resolve queue (/admin/resolve). Zero prisma/react
// imports -- every effect (loading matches/members, writing results) stays in the
// shell (lib/bulk-resolve.ts). Two jobs:
//
//   1. classifyUnresolved -- turns ONE unresolved Match row + its division's
//      members into a row view: the two players' standing (active/dropped,
//      check-in health), how stale the match is, and a one-line suggested
//      action. Pure function of (match, members, now) -- no clock reads inside.
//   2. planBulkAction -- given the rows the page is showing, which of the
//      admin's selected ids a chosen bulk action may actually touch, and why
//      not for the rest. Never silently drops an id -- every selected id comes
//      back allowed or refused, never both, never neither.

// ---------------------------------------------------------------------------
// Inputs -- plain data the shell has already fetched. Never a prisma entity.

export type CheckinStatusLite = "pending" | "in" | "out" | "dm-failed" | null;

export interface DivisionMemberInput {
  playerId: string;
  displayName: string;
  // DivisionMemberStatus is "ACTIVE" | "DROPPED" today; kept as `string` so an
  // unrecognized future status degrades to "UNKNOWN" instead of throwing.
  status: string;
  droppedAt: Date | null;
  checkinStatus: CheckinStatusLite;
  checkinAt: Date | null;
}

export interface UnresolvedMatchInput {
  id: string;
  divisionId: string;
  playerAId: string;
  playerBId: string;
  // PairingStatus is "PENDING" | "CONFIRMED" | "DISPUTED" | "CANCELLED"; the
  // loader only ever hands this core PENDING/DISPUTED rows (a CONFIRMED or
  // CANCELLED match is never in the queue), but the type stays `string` so a
  // stray row degrades to the defensive "OTHER" row status below instead of
  // throwing.
  status: string;
  createdAt: Date;
  reportedAt: Date | null;
  confirmedAt: Date | null;
  disputedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Output -- the row view + suggestion the page renders per match.

// PENDING = reported, awaiting opponent confirm. DISPUTED = opponent rejected.
// UNPLAYED_SCHEDULED = PENDING with nobody having reported anything at all yet
// (a scheduled pairing that's just sitting there). OTHER is defensive only --
// the loader never hands this core a CONFIRMED/CANCELLED match.
export type RowStatus = "PENDING" | "DISPUTED" | "UNPLAYED_SCHEDULED" | "OTHER";

export interface PlayerStanding {
  playerId: string;
  displayName: string;
  memberStatus: "ACTIVE" | "DROPPED" | "UNKNOWN";
  droppedAt: Date | null;
  checkinStatus: CheckinStatusLite;
  checkinAt: Date | null;
  // null = no check-in problem. Otherwise a short human reason ("opted out of
  // check-in", "check-in DM failed to deliver", "no response to check-in
  // after Nd") -- the thing that makes this player a forfeit/void candidate.
  checkinIssue: string | null;
}

// Mirrors BulkAction (below) for void/forfeit-a/forfeit-b so a suggestion can
// be applied as-is; needs-human/leave are suggestion-only, never a bulk action.
export type SuggestedActionKind = "void" | "forfeit-a" | "forfeit-b" | "needs-human" | "leave";

export interface Suggestion {
  action: SuggestedActionKind;
  reason: string;
}

export interface UnresolvedRow {
  matchId: string;
  divisionId: string;
  status: RowStatus;
  playerA: PlayerStanding;
  playerB: PlayerStanding;
  // The most recent of created/reported/confirmed/disputed -- "when this match
  // last had anything happen to it".
  lastTouchedAt: Date;
  daysSinceTouch: number;
  suggestion: Suggestion;
}

// A check-in asked more than this many days ago with no reply counts as
// "has not responded" for the forfeit/void suggestion. Not a hard rule
// (admins can always override via the toolbar) -- just the queue's default
// read on staleness.
export const CHECKIN_STALE_DAYS = 3;

function daysBetween(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
}

function latestOf(dates: readonly (Date | null)[]): Date {
  let latest: Date | null = null;
  for (const d of dates) {
    if (d !== null && (latest === null || d.getTime() > latest.getTime())) latest = d;
  }
  // createdAt is always provided by the caller, so this fallback is never hit
  // in practice -- kept so the function stays total.
  /* v8 ignore next */
  return latest ?? new Date(0);
}

function rowStatusOf(match: UnresolvedMatchInput): RowStatus {
  if (match.status === "DISPUTED") return "DISPUTED";
  if (match.status === "PENDING") return match.reportedAt === null ? "UNPLAYED_SCHEDULED" : "PENDING";
  return "OTHER";
}

function checkinIssueFor(m: DivisionMemberInput, now: Date): string | null {
  if (m.checkinStatus === "out") return "opted out of check-in";
  if (m.checkinStatus === "dm-failed") return "check-in DM failed to deliver";
  if (m.checkinStatus === "pending" && m.checkinAt !== null) {
    const age = daysBetween(now, m.checkinAt);
    if (age >= CHECKIN_STALE_DAYS) return `no response to check-in after ${age}d`;
  }
  return null;
}

function standingFor(playerId: string, members: readonly DivisionMemberInput[], now: Date): PlayerStanding {
  const m = members.find((mm) => mm.playerId === playerId);
  if (!m) {
    // Not found among the division's members -- e.g. moved divisions, or a
    // data gap. Treat as unknown rather than guessing active or dropped.
    return {
      playerId,
      displayName: playerId,
      memberStatus: "UNKNOWN",
      droppedAt: null,
      checkinStatus: null,
      checkinAt: null,
      checkinIssue: null,
    };
  }
  const memberStatus: "ACTIVE" | "DROPPED" | "UNKNOWN" =
    m.status === "ACTIVE" ? "ACTIVE" : m.status === "DROPPED" ? "DROPPED" : "UNKNOWN";
  return {
    playerId: m.playerId,
    displayName: m.displayName,
    memberStatus,
    droppedAt: m.droppedAt,
    checkinStatus: m.checkinStatus,
    checkinAt: m.checkinAt,
    checkinIssue: checkinIssueFor(m, now),
  };
}

// Decision tree, in order:
//   1. OTHER (defensive -- already resolved) -> leave.
//   2. DISPUTED -> needs a human, regardless of either player's standing: a
//      contested score needs a look no matter who's dropped since.
//   3. Either player dropped -> void.
//   4. Both players have a check-in issue -> void.
//   5. Exactly one player has a check-in issue (and the other doesn't) ->
//      forfeit against the one with the issue.
//   6. Otherwise (both active, no check-in issue) -> leave.
function suggestFor(status: RowStatus, a: PlayerStanding, b: PlayerStanding): Suggestion {
  if (status === "OTHER") {
    return { action: "leave", reason: "leave -- already resolved, not an open match" };
  }
  if (status === "DISPUTED") {
    return { action: "needs-human", reason: "needs a human -- disputed, review by hand" };
  }

  const aDropped = a.memberStatus === "DROPPED";
  const bDropped = b.memberStatus === "DROPPED";
  if (aDropped || bDropped) {
    const who =
      aDropped && bDropped
        ? `${a.displayName} and ${b.displayName} both dropped`
        : aDropped
          ? `${a.displayName} dropped`
          : `${b.displayName} dropped`;
    return { action: "void", reason: `void -- ${who}` };
  }

  const aIssue = a.checkinIssue !== null;
  const bIssue = b.checkinIssue !== null;
  if (aIssue && bIssue) {
    return {
      action: "void",
      reason: `void -- both ${a.displayName} (${a.checkinIssue}) and ${b.displayName} (${b.checkinIssue})`,
    };
  }
  if (aIssue) {
    return { action: "forfeit-a", reason: `forfeit against ${a.displayName} -- ${a.checkinIssue}` };
  }
  if (bIssue) {
    return { action: "forfeit-b", reason: `forfeit against ${b.displayName} -- ${b.checkinIssue}` };
  }
  return { action: "leave", reason: "leave -- both active and recent" };
}

// The single entry point the loader calls per unresolved match. Deterministic
// and order-independent: depends only on this match's own fields, this
// division's member list (searched by id, so member array order never
// matters), and the injected `now` -- never today's real clock, never any
// other row's state.
export function classifyUnresolved(
  match: UnresolvedMatchInput,
  members: readonly DivisionMemberInput[],
  now: Date,
): UnresolvedRow {
  const status = rowStatusOf(match);
  const playerA = standingFor(match.playerAId, members, now);
  const playerB = standingFor(match.playerBId, members, now);
  const lastTouchedAt = latestOf([match.createdAt, match.reportedAt, match.confirmedAt, match.disputedAt]);
  return {
    matchId: match.id,
    divisionId: match.divisionId,
    status,
    playerA,
    playerB,
    lastTouchedAt,
    daysSinceTouch: daysBetween(now, lastTouchedAt),
    suggestion: suggestFor(status, playerA, playerB),
  };
}

// ---------------------------------------------------------------------------
// planBulkAction -- what the toolbar's chosen action may do to each selected row.

// void/forfeit-a/forfeit-b mirror the single-match helpers in lib/match-admin.ts
// (void = cancelMatch, forfeit-a/b = forfeitResult with the loser being A/B).
// double-forfeit has no "both lose" shape in the Match model (see
// lib/bulk-resolve.ts) -- it's represented as a void with a prefixed reason,
// but still goes through the same allow/refuse rules as a plain void here.
export type BulkAction = "void" | "forfeit-a" | "forfeit-b" | "double-forfeit";

export interface BulkActionDecision {
  id: string;
  allowed: boolean;
  // Required (non-null) exactly when allowed is false; null when allowed.
  reason: string | null;
}

// Every id in `selectedIds` comes back exactly once, as either `allowed: true`
// or `allowed: false` with a reason -- never both, never neither, and never
// silently dropped (an id with no matching row -- already resolved, or never
// existed -- is refused, not ignored). Order-independent: looks each id up by
// value, never by position.
export function planBulkAction(
  rows: readonly UnresolvedRow[],
  selectedIds: readonly string[],
  action: BulkAction,
): BulkActionDecision[] {
  const byId = new Map(rows.map((r) => [r.matchId, r] as const));
  const uniqueIds = [...new Set(selectedIds)];
  return uniqueIds.map((id) => {
    const row = byId.get(id);
    if (!row) {
      return { id, allowed: false, reason: "Not in the unresolved queue (already resolved, or doesn't exist)." };
    }
    if (row.status === "OTHER") {
      return { id, allowed: false, reason: "Already resolved -- not an open match." };
    }
    if (row.status === "DISPUTED" && action !== "void") {
      return {
        id,
        allowed: false,
        reason: "Disputed matches can't be bulk-forfeited -- void it or resolve the dispute by hand.",
      };
    }
    return { id, allowed: true, reason: null };
  });
}
