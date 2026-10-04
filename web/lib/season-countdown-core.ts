// Pure core for "when does the current season end" countdowns, shared by
// /me's quick-actions strip and the admin dashboard home. All inputs are
// plain epoch-ms numbers -- the clock is injected by the caller (a server
// component passes Date.now()); this module never reads the clock itself.
//
// Day math is calendar-day based (UTC epoch-day index), not raw millisecond
// duration, so a start/end that falls later *today* still reads as "today"
// rather than rounding up to "in 1 day". Future day counts are otherwise
// the ceiling of whole days between now's day and the target day.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayIndex(ms: number): number {
  return Math.floor(ms / MS_PER_DAY);
}

// Whole calendar days from `fromMs`'s day to `toMs`'s day. Positive when
// `toMs` falls on a later day, negative when earlier, 0 when the same day.
function dayDiff(fromMs: number, toMs: number): number {
  return dayIndex(toMs) - dayIndex(fromMs);
}

function pluralDays(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

export type SeasonCountdownKind = "ended" | "ends" | "no-end-set" | "not-started";

export interface SeasonCountdownInput {
  startMs: number;
  scheduledEndMs: number | null;
  endedMs: number | null;
  nowMs: number;
}

export interface SeasonCountdownResult {
  kind: SeasonCountdownKind;
  daysLeft: number | null;
  label: string;
}

export function seasonCountdown({
  startMs,
  scheduledEndMs,
  endedMs,
  nowMs,
}: SeasonCountdownInput): SeasonCountdownResult {
  // A season that hasn't reached its start day yet is "not started",
  // regardless of any end info -- that takes priority over everything else.
  if (dayIndex(nowMs) < dayIndex(startMs)) {
    const daysLeft = dayDiff(nowMs, startMs);
    return { kind: "not-started", daysLeft, label: `Starts in ${pluralDays(daysLeft)}` };
  }

  // The authoritative end moment: an actual close (endedMs) wins over a
  // merely-scheduled one, since an admin can end a season early or late.
  const effectiveEndMs = endedMs ?? scheduledEndMs;

  if (effectiveEndMs === null) {
    return { kind: "no-end-set", daysLeft: null, label: "No end date set" };
  }

  const diff = dayDiff(nowMs, effectiveEndMs);

  if (diff < 0) {
    const daysAgo = -diff;
    return { kind: "ended", daysLeft: daysAgo, label: `Ended ${pluralDays(daysAgo)} ago` };
  }

  if (diff === 0) {
    return { kind: "ends", daysLeft: 0, label: "Ends today" };
  }

  return { kind: "ends", daysLeft: diff, label: `Ends in ${pluralDays(diff)}` };
}
