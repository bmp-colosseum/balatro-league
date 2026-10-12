// Plain-English (non-Discord-markup) rendering of a season's start/end
// window, for the public /how-it-works page. Mirrors the SHAPE of the bot's
// src/season-timing.ts seasonWindowLines() (same branches: no active season
// with/without a scheduled start, active season with/without a scheduled
// end) but formats dates as readable text instead of Discord <t:...> tags,
// since those don't render outside Discord. Feeds straight into
// onboarding-guide.ts's `seasonWindowLines` input, so the fallback copy for
// "nothing scheduled" is the guide's own (shared with the DM), not
// duplicated here.

export interface SeasonWindowInput {
  scheduledStartAt?: Date | null;
  startedAt?: Date | null;
  scheduledEndAt?: Date | null;
  isActive: boolean;
}

function formatDate(d: Date): string {
  // Pinned to UTC: the stored timestamp is a date-only concept (a season's
  // day boundary), and rendering in the server's local timezone would shift
  // the displayed day depending on where the process happens to run.
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function seasonWindowLinesPlain(opts: SeasonWindowInput): string[] {
  const { scheduledStartAt, startedAt, scheduledEndAt, isActive } = opts;

  if (!isActive) {
    if (scheduledStartAt) return [`Season starts ${formatDate(scheduledStartAt)}`];
    return [];
  }

  const lines: string[] = [];
  lines.push(startedAt ? `Started ${formatDate(startedAt)}` : "Started recently");
  if (scheduledEndAt) lines.push(`Ends around ${formatDate(scheduledEndAt)}`);
  return lines;
}

// The ISO date(s) baked (as a UTC-formatted fallback) into seasonWindowLinesPlain's
// output, in the SAME order the dates appear across those lines -- lets a client
// component (SeasonDateSync) find-and-replace the fallback text for the viewer's
// own timezone after hydration, same as /standings' SeasonWindow (LocalDateTime),
// instead of leaving the guide pinned to a UTC date that can read a day off from
// what /standings shows (see .claude/knowledge/ux-round3/01-findings.md finding 7).
// Returns [] whenever seasonWindowLinesPlain would have embedded no date at all
// (the "Started recently" fallback).
export interface SeasonWindowDate {
  iso: string;
  // Exact substring formatDate() produced for this date -- what's actually
  // sitting in the rendered guide body text today, so the client pass can
  // find it verbatim.
  fallback: string;
}

export function seasonWindowDates(opts: SeasonWindowInput): SeasonWindowDate[] {
  const { scheduledStartAt, startedAt, scheduledEndAt, isActive } = opts;
  const dates: SeasonWindowDate[] = [];

  if (!isActive) {
    if (scheduledStartAt) dates.push({ iso: scheduledStartAt.toISOString(), fallback: formatDate(scheduledStartAt) });
    return dates;
  }

  if (startedAt) dates.push({ iso: startedAt.toISOString(), fallback: formatDate(startedAt) });
  if (scheduledEndAt) dates.push({ iso: scheduledEndAt.toISOString(), fallback: formatDate(scheduledEndAt) });
  return dates;
}
