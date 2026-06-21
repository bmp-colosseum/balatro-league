// Helpers for picking a player's "best" balatromp (BMP) MMR snapshot. The
// preference — highest tagged BMP season, then most recent capture — was
// duplicated across the standings + admin loaders; centralized here.
//
// Done in JS (not SQL) because Prisma can't distinct/sort by the numeric suffix
// of the `bmpSeason` string tag ("season6").

// Parse a bmpSeason tag ("season6" → 6). Null / untagged → -Infinity so ad-hoc
// captures sort after any real season.
export function bmpSeasonNumber(tag: string | null): number {
  if (!tag) return -Infinity;
  const m = /^season(\d+)$/.exec(tag);
  return m ? parseInt(m[1]!, 10) : -Infinity;
}

// Sort comparator (best-first) for a player's BMP snapshots: highest tagged
// season wins, then most recent capture. Use as `snapshots.sort(byBestBmpSnapshot)`
// so element [0] is the preferred snapshot.
export function byBestBmpSnapshot(
  a: { bmpSeason: string | null; capturedAt: Date },
  b: { bmpSeason: string | null; capturedAt: Date },
): number {
  const na = bmpSeasonNumber(a.bmpSeason);
  const nb = bmpSeasonNumber(b.bmpSeason);
  if (na !== nb) return nb - na;
  return b.capturedAt.getTime() - a.capturedAt.getTime();
}
