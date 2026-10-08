// Pure post-process for showing (NOT breaking ties by) net lives under the
// default "chain" tiebreak. computeStandings/computeBestNStandings only
// attach netLives/livesGamesMissing to every row -- and only reorder by it
// -- when called with tiebreak: "lives". Under the default "chain" tiebreak
// the engines never touch netLives at all, so chain-mode ordering is
// untouched no matter what. The TO still wants a TIED player's net life
// differential to show up as informational context (see computeNetLives's
// header in ./standings.js) without switching the season's tiebreak. This
// module runs AFTER computeStandings/computeBestNStandings as a pure
// post-process over their already-sorted+ranked output, so the engines'
// chain output stays byte-for-byte identical whether or not this runs.
// Mirrors web/lib/standings-lives.ts EXACTLY -- if you change one copy,
// change both.

import { computeNetLives, type StandingRow, type PairingWithLives } from "./standings.js";

// True when row i shares its rank with a neighbor: either IT was marked
// tiedWithPrev (tied with the row above), or the NEXT row was (tied with
// this one from below). Checked directly off tiedWithPrev on both rows
// rather than trusting tiedWithNext to already be set on `rows[i]`, so this
// works over any sorted+tied-marked rows array, not just one that's already
// been through assignRanks in this exact call.
function isInTieGroup(rows: readonly StandingRow[], i: number): boolean {
  const cur = rows[i];
  if (!cur) return false;
  if (cur.tiedWithPrev) return true;
  const next = rows[i + 1];
  return !!next?.tiedWithPrev;
}

// Attaches netLives/livesGamesMissing (via the same computeNetLives the
// "lives" tiebreak uses) to every row that's part of a tie group. Rows NOT
// in a tie group are left completely untouched -- no netLives/
// livesGamesMissing keys at all -- so a division with zero ties comes back
// byte-for-byte identical to its input, and a chain-mode payload with no
// ties stays exactly as it was before this function existed. Mutates +
// returns `rows`, mirroring assignRanks's convention.
export function attachLivesToTiedRows(
  rows: StandingRow[],
  pairings: Array<Pick<PairingWithLives, "playerAId" | "playerBId" | "games">>,
): StandingRow[] {
  rows.forEach((row, i) => {
    if (!isInTieGroup(rows, i)) return;
    const { netLives, livesGamesMissing } = computeNetLives(row.player.id, pairings);
    row.netLives = netLives;
    row.livesGamesMissing = livesGamesMissing;
  });
  return rows;
}
