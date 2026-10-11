// Pure decision core for "auto-open signups" -- cuts the manual step where an
// admin opens next season's signups by hand about a week into the current
// season. Shared by the bot's hourly tick (src/auto-signups.ts) and the web
// Season Tools status line (web/lib/auto-signups.ts); synced into
// web/lib/auto-signups-core.ts by web/scripts/sync-schema.mjs, same pattern
// as schedule.ts / owen-placement.ts / standings-mode.ts.
//
// Deliberately takes only plain values -- no Prisma rows, no Date.now() reads
// inside -- so every branch is a one-line table test with no DB or clock
// faking required.

export const MS_PER_DAY = 86_400_000;

export interface AutoSignupInput {
  // Clock reads happen at the call site; passed in so "due" is deterministic.
  now: Date;
  // LeagueConfig signups_auto_open_days. 0 (or negative) means the feature is
  // off regardless of every other input.
  autoOpenDays: number;
  // The currently-active season's start date -- the anchor the due date is
  // computed from (startedAt + autoOpenDays).
  activeSeasonStartedAt: Date;
  // Does a Season with number = activeSeason.number + 1 already exist? If
  // not, the tick must create it before it can open signups for it.
  nextSeasonExists: boolean;
  // Has ANY SignupRound ever been created for that next season (any status --
  // OPEN, CLOSED, or BUILT)? True means signups for it were already handled
  // (by a human or by a prior tick) -- never create a second round for the
  // same season even after it closes.
  nextSeasonHadRound: boolean;
  // Is there an OPEN SignupRound anywhere right now (for ANY season)? Only one
  // round may be OPEN system-wide (see openSignupsForSeason's stale-round
  // comment), so this alone is enough to know "signups are already open".
  anyOpenRoundExists: boolean;
  // The active season's planned end. When set, the setting means "this many
  // days BEFORE the season ends" (the TO's rhythm: signups open and the
  // one-week-left reminder goes out a week before the end). When unset the
  // due date falls back to startedAt + autoOpenDays.
  activeSeasonScheduledEndAt?: Date | null;
}

// The moment signups open and the "one week left" reminder posts.
export function autoSignupsDueAt(input: Pick<AutoSignupInput, "autoOpenDays" | "activeSeasonStartedAt" | "activeSeasonScheduledEndAt">): Date {
  return input.activeSeasonScheduledEndAt
    ? addDays(input.activeSeasonScheduledEndAt, -input.autoOpenDays)
    : addDays(input.activeSeasonStartedAt, input.autoOpenDays);
}

// Is the "one week left" announcement due for this season? Pure; the shell
// passes the season number the reminder was last posted for.
export function weekLeftReminderDue(input: {
  now: Date;
  autoOpenDays: number;
  activeSeasonNumber: number;
  activeSeasonStartedAt: Date;
  activeSeasonScheduledEndAt: Date | null;
  lastReminderSeasonNumber: number | null;
}): boolean {
  if (!Number.isFinite(input.autoOpenDays) || input.autoOpenDays <= 0) return false;
  if (!input.activeSeasonScheduledEndAt) return false; // no end date, nothing to count down to
  if (input.lastReminderSeasonNumber === input.activeSeasonNumber) return false;
  if (input.now.getTime() >= input.activeSeasonScheduledEndAt.getTime()) return false; // season already over
  return input.now.getTime() >= autoSignupsDueAt(input).getTime();
}

export type AutoSignupDecision =
  // autoOpenDays <= 0 -- feature disabled, nothing else matters.
  | { action: "off" }
  // Not due yet -- dueAt is activeSeasonStartedAt + autoOpenDays days.
  | { action: "wait"; dueAt: Date }
  // Due, but the next season doesn't exist yet -- create it, then open it.
  | { action: "needs-next-season" }
  // Due, next season exists and already has a round -- nothing to do.
  | { action: "already-open" }
  // Due, next season exists, no round yet, nothing else is open -- go.
  | { action: "open-now" };

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

// The single decision the tick (and the status line) make from plain facts.
// Order matters: "off" and "already open" both short-circuit ahead of the due
// check so a late-running tick can never reopen or double-create.
export function decideAutoSignups(input: AutoSignupInput): AutoSignupDecision {
  if (!Number.isFinite(input.autoOpenDays) || input.autoOpenDays <= 0) {
    return { action: "off" };
  }
  if (input.anyOpenRoundExists) {
    return { action: "already-open" };
  }
  if (input.nextSeasonExists && input.nextSeasonHadRound) {
    return { action: "already-open" };
  }
  const dueAt = autoSignupsDueAt(input);
  if (input.now.getTime() < dueAt.getTime()) {
    return { action: "wait", dueAt };
  }
  if (!input.nextSeasonExists) {
    return { action: "needs-next-season" };
  }
  return { action: "open-now" };
}
