import "server-only";

// Loader for /admin/play-times: every CONFIRMED match's play timestamp
// (coalesce(confirmedAt, reportedAt)) plus every Season's date range, as the
// plain scalar arrays play-times-core.ts's pure computePlayTimes() expects.
// No caching -- ~1700 rows today, cheap enough for one query per load.

import { prisma } from "@/lib/prisma";
import type { PlayTimesMatch, PlayTimesSeason } from "@/lib/play-times-core";

export interface PlayTimesPageData {
  matches: PlayTimesMatch[];
  seasons: PlayTimesSeason[];
}

export async function loadPlayTimesData(): Promise<PlayTimesPageData> {
  const [seasons, confirmedMatches] = await Promise.all([
    prisma.season.findMany({
      select: { number: true, startedAt: true, endedAt: true, scheduledEndAt: true, isActive: true },
    }),
    prisma.match.findMany({
      where: {
        status: "CONFIRMED",
        OR: [{ confirmedAt: { not: null } }, { reportedAt: { not: null } }],
      },
      select: {
        confirmedAt: true,
        reportedAt: true,
        division: { select: { season: { select: { number: true } } } },
      },
    }),
  ]);

  const matches: PlayTimesMatch[] = [];
  for (const match of confirmedMatches) {
    const at = match.confirmedAt ?? match.reportedAt;
    if (!at) continue; // guarded by the WHERE above; satisfies the type checker
    matches.push({ seasonNumber: match.division.season.number, atMs: at.getTime() });
  }

  const seasonRows: PlayTimesSeason[] = seasons.map((season) => ({
    number: season.number,
    startMs: season.startedAt.getTime(),
    endMs: (season.endedAt ?? season.scheduledEndAt)?.getTime() ?? null,
    active: season.isActive,
  }));

  return { matches, seasons: seasonRows };
}
