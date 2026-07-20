// Discord "hammertime" for a season's soft end deadline (Season.scheduledEndAt).
// A <t:UNIX:...> tag renders in each viewer's LOCAL timezone and self-updates the
// relative countdown, so a pinned message stays current without ever being
// re-posted. Returns null / "" when no end date is set (it's TO-managed + optional).

export function seasonEndsHammer(endsAt: Date | null | undefined): { full: string; relative: string } | null {
  if (!endsAt) return null;
  const unix = Math.floor(endsAt.getTime() / 1000);
  return { full: `<t:${unix}:F>`, relative: `<t:${unix}:R>` };
}

// A prominent (h2) header line for a pinned message; "" when no end date is set so
// callers can drop it into a line array behind a truthiness check. ⏰ = alarm
// clock (kept as an escape so the source stays ASCII).
export function seasonEndsHeader(endsAt: Date | null | undefined): string {
  const h = seasonEndsHammer(endsAt);
  return h ? `## ⏰ Season ends ${h.full} - ${h.relative}` : "";
}

export const DEFAULT_TIEBREAK_BUFFER_DAYS = 2;

// The full end-of-season timeline for a pinned message: the hard "finish your
// games by" deadline, the buffer we then take to settle shootouts/tiebreakers
// (and give everyone a breather), and roughly when the next season starts. The
// next-season date is DERIVED as deadline + buffer rather than read from the
// unbuilt next season, so it stays accurate before that season exists.
// Returns [] when no end date is set.
export function seasonTimelineLines(
  endsAt: Date | null | undefined,
  bufferDays: number = DEFAULT_TIEBREAK_BUFFER_DAYS,
): string[] {
  const h = seasonEndsHammer(endsAt);
  if (!h || !endsAt) return [];
  const days = Number.isFinite(bufferDays) && bufferDays >= 0 ? Math.floor(bufferDays) : DEFAULT_TIEBREAK_BUFFER_DAYS;
  const nextUnix = Math.floor((endsAt.getTime() + days * 24 * 60 * 60 * 1000) / 1000);
  const dayWord = days === 1 ? "day" : "days";
  return [
    `## ⏰ Finish all your games by ${h.full} (${h.relative})`,
    `_Then we take **${days} ${dayWord}** to settle any shootouts/tiebreakers and give everyone a short break - the next season kicks off around <t:${nextUnix}:D>._`,
  ];
}

// Read the configured buffer, falling back to the default. Kept here so both
// pinned-message surfaces resolve it the same way.
export function parseBufferDays(raw: string | null | undefined): number {
  // Guard unset/blank FIRST: Number(null) and Number("") are both 0, which would
  // silently mean "no buffer at all" instead of falling back to the default.
  if (raw == null || raw.trim() === "") return DEFAULT_TIEBREAK_BUFFER_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TIEBREAK_BUFFER_DAYS;
}
