// Pure season-scoring-mode selector. Shared by the bot's live standings post
// (standings-channel-content.ts / standings-cache.ts) and the web's live
// standings path (web/lib/standings-cache.ts, web/lib/loaders/standings.ts,
// web/lib/loaders/division.ts) via web/scripts/sync-schema.mjs -- this file
// has zero local imports, so the synced copy at web/lib/standings-mode.ts
// works unmodified. No DB, no Prisma -- decides nothing about dropouts
// itself, just which engine a caller should run.

// Season.scoringMode is a free-text column (so flipping back to "all" is a
// plain write, not a migration). This is the known set of values the admin
// UI (web/app/admin/standings-preview) can write.
export type SeasonScoringMode = "all" | "best-n-count" | "best-n-void";

// Normalizes the free-text column to the known literal union, defaulting to
// "all" for anything unrecognized (a future mode this deployment doesn't
// know about yet, bad data, or a column not yet migrated in some
// environment) -- the live standings path must always resolve to SOME
// engine, never throw on an unexpected value.
export function normalizeScoringMode(raw: string | null | undefined): SeasonScoringMode {
  if (raw === "best-n-count" || raw === "best-n-void") return raw;
  return "all";
}

export type StandingsEngineSelection =
  | { engine: "standard" }
  | { engine: "best-n"; dropoutGames: "count" | "void" };

// Which engine a division's LIVE standings should run through, given its
// season's (already-normalized) scoringMode. Doesn't know about dropouts --
// computeBestNStandings bypasses to plain standings itself when a division
// has zero unreplaced dropouts, so "best-n" here just means "run it through
// that engine and let IT decide."
export function selectStandingsEngine(mode: SeasonScoringMode): StandingsEngineSelection {
  if (mode === "best-n-count") return { engine: "best-n", dropoutGames: "count" };
  if (mode === "best-n-void") return { engine: "best-n", dropoutGames: "void" };
  return { engine: "standard" };
}

// Display badge for "counts best N of K-1" -- null when there's nothing
// worth showing: standard mode, or a best-n mode where this division
// currently has zero unreplaced dropouts (computeBestNStandings already
// bypassed to plain-standings numbers, identical to "all").
export interface ScoringBadge {
  mode: SeasonScoringMode;
  n: number;
  k: number;
  scheduled: number;
  dropouts: number;
}

export function buildScoringBadge(
  mode: SeasonScoringMode,
  n: number,
  k: number,
  scheduled: number,
  dropouts: number,
): ScoringBadge | null {
  if (mode === "all" || dropouts <= 0) return null;
  return { mode, n, k, scheduled, dropouts };
}
