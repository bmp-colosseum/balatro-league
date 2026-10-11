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
