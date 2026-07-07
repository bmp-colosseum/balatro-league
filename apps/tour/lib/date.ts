// Soft-deadline date helpers. Deadlines are stored as UTC instants but authored and
// displayed in ET (America/New_York) -- the tour's canonical "Sun 23:59 ET" cadence.
// Dependency-free (Intl only). "Soft" is a product stance: a deadline is a target/nudge,
// never a lock, so nothing here enforces -- it only converts and formats.
const ET = "America/New_York";

function etParts(d: Date) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const hour = g("hour") === "24" ? 0 : Number(g("hour")); // some ICU emit "24" for midnight
  return { year: Number(g("year")), month: Number(g("month")), day: Number(g("day")), hour, minute: Number(g("minute")) };
}

// Interpret a datetime-local wall string ("2026-07-12T23:59") as ET and return the
// matching UTC instant. Offset-discovery round-trip so DST is handled automatically.
export function etWallToUtc(wall: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); // pretend the wall time is UTC
  const et = etParts(new Date(guess)); // what ET clock reads at that instant
  const etAsUtc = Date.UTC(et.year, et.month - 1, et.day, et.hour, et.minute);
  return new Date(guess + (guess - etAsUtc)); // correct by ET's offset
}

// A stored UTC instant back to a datetime-local ET wall string (to prefill the input).
export function utcToEtWall(d: Date): string {
  const p = etParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// Add whole days to a wall string, keeping the same time-of-day (for a weekly cadence).
export function addDaysWall(wall: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return wall;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + days * 86400000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// "Sun, Jul 12" (short, for the chip face).
export function formatDeadlineShortET(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" }).format(d);
}

// "Sun, Jul 12, 11:59 PM ET" (full, for the chip tooltip).
export function formatDeadlineFullET(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d) + " ET";
}

// A soft relative label. Never alarmist: past just reads "Nd ago" (a nudge, not a lock).
export function deadlineRelative(d: Date, now: Date): { text: string; past: boolean } {
  const ms = d.getTime() - now.getTime();
  const past = ms < 0;
  const days = Math.round(Math.abs(ms) / 86400000);
  const text = days === 0 ? "today" : past ? `${days}d ago` : `in ${days}d`;
  return { text, past };
}
