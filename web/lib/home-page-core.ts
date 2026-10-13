// Pure helpers for the home page (app/page.tsx) "This season" intro block,
// and the season-wide match-progress tally it shares with the embedded
// standings board (components/StandingsBoard.tsx) -- no React/Prisma/
// Date.now() here. Callers gather the season's already-loaded standings
// data (loadStandingsPageData, the same loader /standings uses) and hand
// plain values in.

export interface MatchCountSource {
  divisions: readonly { expectedMatches: number; playedMatches: number }[];
}

/** Season-wide match progress -- sum of every division's round-robin.
 *  Shared by the home page's "This season" card and StandingsBoard's
 *  progress bar so the two numbers can never drift apart. */
export function seasonMatchTotals(tiers: readonly MatchCountSource[]): {
  totalPlayed: number;
  totalExpected: number;
} {
  let totalPlayed = 0;
  let totalExpected = 0;
  for (const t of tiers) {
    for (const d of t.divisions) {
      totalExpected += d.expectedMatches;
      totalPlayed += d.playedMatches;
    }
  }
  return { totalPlayed, totalExpected };
}

export interface SeasonProgressInput {
  totalPlayed: number;
  totalExpected: number;
}

/** "12 of 174 matches played (7%)" -- the home page's one-line season
 *  progress summary. A neutral line when nothing is scheduled yet (no
 *  active season's divisions built, or an empty ladder) rather than a
 *  div-by-zero NaN%. */
export function seasonProgressLine({ totalPlayed, totalExpected }: SeasonProgressInput): string {
  if (totalExpected <= 0) return "No matches scheduled yet";
  const pct = Math.round((totalPlayed / totalExpected) * 100);
  return `${totalPlayed} of ${totalExpected} matches played (${pct}%)`;
}

export interface TopDivisionSourceRow {
  player: { displayName: string };
  points: number;
}

export interface TopDivisionRow {
  rank: number;
  displayName: string;
  points: number;
}

export interface TopDivisionTierSource<T extends TopDivisionSourceRow> {
  name: string;
  divisions: readonly { rows: readonly T[] }[];
}

/** Top `limit` rows (standings order -- callers pass already-ranked rows) of
 *  the FIRST division in the named tier, e.g. the home page's "top of
 *  Legendary" teaser. Returns [] when the tier isn't present or has no
 *  divisions/rows -- callers render nothing rather than an empty card. A
 *  non-positive limit also returns []. */
export function topDivisionRows<T extends TopDivisionSourceRow>(
  tiers: readonly TopDivisionTierSource<T>[],
  tierName: string,
  limit: number,
): TopDivisionRow[] {
  const tier = tiers.find((t) => t.name === tierName);
  const division = tier?.divisions[0];
  if (!division || limit <= 0) return [];
  return division.rows.slice(0, limit).map((row, i) => ({
    rank: i + 1,
    displayName: row.player.displayName,
    points: row.points,
  }));
}
