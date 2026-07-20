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
