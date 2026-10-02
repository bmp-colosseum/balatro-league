// Helpers for picking a player's "best" balatromp (BMP) MMR snapshot. The
// preference — highest tagged BMP season, then most recent capture — was
// duplicated across the standings + admin loaders; centralized here.
//
// bmpSeasonNumber/byBestBmpSnapshot stay in JS (not SQL) because Prisma can't
// distinct/sort by the numeric suffix of the `bmpSeason` string tag
// ("season6") — the admin loaders still pull every snapshot for a small set
// of players and sort in JS with these. loadBestBmpSnapshotsForPlayerIds below
// pushes the SAME preference into one raw-SQL DISTINCT ON query for the
// standings/division/season pages, which call it over EVERY player visible on
// the page and were loading every snapshot ever captured (unbounded history)
// just to keep the single best one.

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

export interface BestBmpSnapshotRow {
  playerId: string;
  bmpSeason: string | null;
  rankedMmr: number;
  capturedAt: Date;
}

// Minimal shape loadBestBmpSnapshotsForPlayerIds needs from a Prisma client —
// just $queryRaw, injected so callers can pass a test double instead of the
// real singleton (DI seam per the repo's testable-business-logic convention).
export interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

// One row per player: their best snapshot (highest tagged bmpSeason, then
// most recent capture) among rows that actually have a ranked MMR — the SAME
// preference as byBestBmpSnapshot/bmpSeasonNumber above, pushed into Postgres
// via DISTINCT ON so we transfer exactly one row per player instead of their
// entire capture history. bmpSeason follows "season<N>"; untagged (null) or
// non-matching tags sort last via the very-negative COALESCE fallback, same
// as bmpSeasonNumber's -Infinity.
export async function loadBestBmpSnapshotsForPlayerIds(
  playerIds: string[],
  client: RawQueryClient,
): Promise<BestBmpSnapshotRow[]> {
  if (playerIds.length === 0) return [];
  return client.$queryRaw<BestBmpSnapshotRow[]>`
    SELECT DISTINCT ON ("playerId") "playerId", "bmpSeason", "rankedMmr", "capturedAt"
    FROM "PlayerMmrSnapshot"
    WHERE "playerId" = ANY(${playerIds}) AND "rankedMmr" IS NOT NULL
    ORDER BY "playerId",
      COALESCE((regexp_match("bmpSeason", '^season(\\d+)$'))[1]::int, -2147483648) DESC,
      "capturedAt" DESC
  `;
}
