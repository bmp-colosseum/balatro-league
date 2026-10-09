// Pure core for the admin Season Tools hub (web/app/admin/season-tools).
// The hub's checklist links into loader output the page already fetches
// (loadSignupRoundsIndex, loadAdminHomeStats, loadSeasonAuditOverview) --
// these two functions are the only real DECISIONS the page makes (which
// signup round is "current", which season the close-out steps point at),
// so they're pulled out here as plain (data in) => (data out) functions a
// unit test can call directly, with no Prisma/loader involved.

export interface SignupRoundSummary {
  id: string;
  status: string;
}

// Picks the signup round the "Review signups" / "Build divisions" steps
// link to: the round still awaiting a build decision. An OPEN round
// outranks a CLOSED one (closing is itself a step the TO takes before
// building), and a BUILT/ENDED round is never "current" -- its build
// decision is already made. `rounds` is assumed pre-sorted
// newest-opened-first (loadSignupRoundsIndex's order), so the first
// qualifying round wins.
export function pickCurrentSignupRound<T extends SignupRoundSummary>(rounds: T[]): T | null {
  return rounds.find((r) => r.status === "OPEN") ?? rounds.find((r) => r.status === "CLOSED") ?? null;
}

// Picks which season the close-out steps (Season audit, Winners, End
// season) point at: the active season while one is running, else whatever
// the season-audit overview already picked as its own default
// (most-recently-ended), so the checklist keeps working right after a
// season just ended and before the next one starts.
export function seasonToolsSeasonId(
  activeSeasonId: string | null,
  auditDefaultSeasonId: string | null,
): string | null {
  return activeSeasonId ?? auditDefaultSeasonId;
}
