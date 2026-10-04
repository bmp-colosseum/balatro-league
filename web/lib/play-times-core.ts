// Pure core for the admin "Play times" page (/admin/play-times). Zero imports --
// colocated test runs under the root vitest project (see vitest.config.ts's
// `include: ["web/lib/**/*.test.ts"]`).
//
// Takes the already-fetched CONFIRMED-match timestamps + Season date ranges
// and produces every number the page renders: an import-batch filter, a
// weekday x hour heatmap, hour-of-day and weekday-of-week totals, and a
// per-season "matches per day since season start" breakdown. The shell
// resolves confirmedAt/reportedAt and Season date fields to plain UTC epoch
// ms before calling in, and supplies the viewer's `Date#getTimezoneOffset()`
// value so every local-time bucket reflects the person looking at the page,
// not the server.

export interface PlayTimesMatch {
  seasonNumber: number;
  atMs: number; // UTC epoch ms -- coalesce(confirmedAt, reportedAt)
}

export interface PlayTimesSeason {
  number: number;
  startMs: number; // UTC epoch ms -- Season.startedAt
  endMs: number | null; // UTC epoch ms -- Season.endedAt ?? Season.scheduledEndAt, or null if neither set
  active: boolean;
}

export interface PlayTimesInput {
  matches: PlayTimesMatch[];
  seasons: PlayTimesSeason[];
  // Date#getTimezoneOffset() convention: localMs = utcMs - tzOffsetMinutes * 60_000.
  tzOffsetMinutes: number;
}

export interface PlayTimesSeasonSummary {
  number: number;
  active: boolean;
  // Matches per day, indexed from 0 = the season's start day, in the viewer's
  // local time. Length extends to cover the latest of the season's end day
  // (if known) and its last played day, so a season with no matches past its
  // end still shows the full span.
  dayCounts: number[];
  // Day index (same indexing as dayCounts) the season ends on, or null when
  // the season has neither endedAt nor scheduledEndAt (nothing to draw a
  // dotted end-line at yet).
  endDay: number | null;
  total: number;
  // Count of this season's kept matches that fall within the final 3 days of
  // the season (day >= endDay - 2), or -- for a season with no known end --
  // within the final 3 days of its own play-time data so far.
  lastThreeDays: number;
}

export interface PlayTimesResult {
  kept: number;
  dropped: number;
  // heat[weekday][hour], weekday 0 = Monday .. 6 = Sunday, hour 0-23, local time.
  heat: number[][];
  // hours[0..23], local time, summed across all weekdays.
  hours: number[];
  // weekdays[0..6], Monday .. Sunday, local time, summed across all hours.
  weekdays: number[];
  perSeason: PlayTimesSeasonSummary[];
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const HOURS_PER_DAY = 24;
const WEEKDAYS_PER_WEEK = 7;
// A minute (UTC) with this many or more confirmations is treated as a bulk
// import / admin batch rather than organic play, and dropped from every chart.
const IMPORT_BATCH_THRESHOLD = 5;
// Width of the "last N days of the season" window used for the lastThreeDays tile.
const LAST_DAYS_WINDOW = 3;

function toLocalMs(utcMs: number, tzOffsetMinutes: number): number {
  return utcMs - tzOffsetMinutes * MINUTE_MS;
}

// getUTCDay()/getUTCHours() read the ms value as-is with no dependence on the
// host's own timezone, so applying them to an already-shifted "local" ms
// value gives a deterministic, environment-independent local hour/weekday.
function localWeekdayMondayFirst(localMs: number): number {
  const sundayFirst = new Date(localMs).getUTCDay(); // 0 = Sunday .. 6 = Saturday
  return (sundayFirst + 6) % 7; // 0 = Monday .. 6 = Sunday
}

function localHour(localMs: number): number {
  return new Date(localMs).getUTCHours();
}

function partitionImportBatches(matches: readonly PlayTimesMatch[]): {
  kept: PlayTimesMatch[];
  droppedCount: number;
} {
  const byUtcMinute = new Map<number, PlayTimesMatch[]>();
  for (const match of matches) {
    const minuteKey = Math.floor(match.atMs / MINUTE_MS);
    const bucket = byUtcMinute.get(minuteKey);
    if (bucket) {
      bucket.push(match);
    } else {
      byUtcMinute.set(minuteKey, [match]);
    }
  }

  const kept: PlayTimesMatch[] = [];
  let droppedCount = 0;
  for (const bucket of byUtcMinute.values()) {
    if (bucket.length >= IMPORT_BATCH_THRESHOLD) {
      droppedCount += bucket.length;
    } else {
      kept.push(...bucket);
    }
  }
  return { kept, droppedCount };
}

function buildSeasonSummary(
  season: PlayTimesSeason,
  seasonMatches: readonly PlayTimesMatch[],
  tzOffsetMinutes: number,
): PlayTimesSeasonSummary {
  const startLocal = toLocalMs(season.startMs, tzOffsetMinutes);
  const endLocal = season.endMs === null ? null : toLocalMs(season.endMs, tzOffsetMinutes);
  const endDay = endLocal === null ? null : Math.floor((endLocal - startLocal) / DAY_MS);

  const dayIndexes = seasonMatches.map((match) => {
    const localMs = toLocalMs(match.atMs, tzOffsetMinutes);
    // Clamp negative indices (a match timestamped before the season's
    // recorded start, e.g. clock skew) onto day 0 rather than discarding it.
    return Math.max(0, Math.floor((localMs - startLocal) / DAY_MS));
  });

  const maxPlayedDay = dayIndexes.reduce((max, day) => Math.max(max, day), 0);
  const spanDay = Math.max(endDay ?? 0, maxPlayedDay);

  const dayCounts = new Array<number>(spanDay + 1).fill(0);
  for (const day of dayIndexes) {
    dayCounts[day] += 1;
  }

  const lastWindowStartDay = (endDay ?? maxPlayedDay) - (LAST_DAYS_WINDOW - 1);
  const lastThreeDays = dayIndexes.filter((day) => day >= lastWindowStartDay).length;

  return {
    number: season.number,
    active: season.active,
    dayCounts,
    endDay,
    total: seasonMatches.length,
    lastThreeDays,
  };
}

export function computePlayTimes(input: PlayTimesInput): PlayTimesResult {
  const { matches, seasons, tzOffsetMinutes } = input;
  const { kept, droppedCount } = partitionImportBatches(matches);

  const heat: number[][] = Array.from({ length: WEEKDAYS_PER_WEEK }, () => new Array<number>(HOURS_PER_DAY).fill(0));
  const hours = new Array<number>(HOURS_PER_DAY).fill(0);
  const weekdays = new Array<number>(WEEKDAYS_PER_WEEK).fill(0);

  const matchesBySeason = new Map<number, PlayTimesMatch[]>();
  for (const match of kept) {
    const localMs = toLocalMs(match.atMs, tzOffsetMinutes);
    const weekday = localWeekdayMondayFirst(localMs);
    const hour = localHour(localMs);
    heat[weekday][hour] += 1;
    hours[hour] += 1;
    weekdays[weekday] += 1;

    const bucket = matchesBySeason.get(match.seasonNumber);
    if (bucket) {
      bucket.push(match);
    } else {
      matchesBySeason.set(match.seasonNumber, [match]);
    }
  }

  const perSeason = seasons
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((season) => buildSeasonSummary(season, matchesBySeason.get(season.number) ?? [], tzOffsetMinutes))
    // A season with no confirmed play yet (a draft for next season, or one whose only
    // results were bulk imports) has nothing to chart and would render as an empty card.
    .filter((summary) => summary.total > 0);

  return {
    kept: kept.length,
    dropped: droppedCount,
    heat,
    hours,
    weekdays,
    perSeason,
  };
}

// --- Summary-tile derivations ----------------------------------------------
// Small pure decisions over computePlayTimes()'s output, kept in the core
// (rather than the client component) so they stay unit-testable without a
// browser or a DOM.

export interface HourWindow {
  // Local hour the window starts at (0-23).
  startHour: number;
  // Window length in hours (constant WINDOW_HOURS; exposed for display math).
  lengthHours: number;
  total: number;
  // total / kept, or 0 when kept is 0.
  share: number;
}

const BUSIEST_WINDOW_HOURS = 4;

// Busiest contiguous N-hour window of the day, wrapping past midnight (so a
// window starting at hour 22 is allowed). Ties break toward the earliest
// start hour for a deterministic result.
export function busiestHourWindow(hours: readonly number[], kept: number): HourWindow {
  if (hours.length === 0) return { startHour: 0, lengthHours: BUSIEST_WINDOW_HOURS, total: 0, share: 0 };
  let bestStart = 0;
  let bestTotal = -1;
  for (let start = 0; start < hours.length; start++) {
    let total = 0;
    for (let offset = 0; offset < BUSIEST_WINDOW_HOURS; offset++) {
      total += hours[(start + offset) % hours.length];
    }
    if (total > bestTotal) {
      bestTotal = total;
      bestStart = start;
    }
  }
  return {
    startHour: bestStart,
    lengthHours: BUSIEST_WINDOW_HOURS,
    total: Math.max(bestTotal, 0),
    share: kept > 0 ? Math.max(bestTotal, 0) / kept : 0,
  };
}

export interface WeekdayExtreme {
  // 0 = Monday .. 6 = Sunday.
  weekday: number;
  total: number;
}

// Busiest weekday by total matches; ties break toward the earliest (Monday-first) index.
export function busiestWeekday(weekdays: readonly number[]): WeekdayExtreme {
  if (weekdays.length === 0) return { weekday: 0, total: 0 };
  let best = 0;
  for (let i = 1; i < weekdays.length; i++) {
    if (weekdays[i] > weekdays[best]) best = i;
  }
  return { weekday: best, total: weekdays[best] };
}

// Quietest weekday by total matches; ties break toward the earliest (Monday-first) index.
export function quietestWeekday(weekdays: readonly number[]): WeekdayExtreme {
  if (weekdays.length === 0) return { weekday: 0, total: 0 };
  let best = 0;
  for (let i = 1; i < weekdays.length; i++) {
    if (weekdays[i] < weekdays[best]) best = i;
  }
  return { weekday: best, total: weekdays[best] };
}

// Share of all kept matches that fall within the final 3 days of their own
// season, across every season -- 0 when there are no matches at all.
export function overallLastThreeDaysShare(perSeason: readonly PlayTimesSeasonSummary[]): number {
  let total = 0;
  let inWindow = 0;
  for (const season of perSeason) {
    total += season.total;
    inWindow += season.lastThreeDays;
  }
  return total > 0 ? inWindow / total : 0;
}
