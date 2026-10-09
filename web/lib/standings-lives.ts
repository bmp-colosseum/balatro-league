// Pure post-process for showing (NOT breaking ties by) net lives under the
// default "chain" tiebreak. computeStandings/computeBestNStandings only
// attach netLives/livesGamesMissing themselves -- and only reorder by it --
// when called with tiebreak: "lives". Under the default "chain" tiebreak the
// engines never touch netLives at all, so chain-mode ordering is untouched
// no matter what. The TO still wants every player's net life differential
// shown as context (see computeNetLives's header in @/lib/standings) without
// switching the season's tiebreak. This module runs AFTER
// computeStandings/computeBestNStandings as a pure post-process over their
// already-sorted+ranked output, so the engines' chain output stays
// byte-for-byte identical whether or not this runs.
// Mirrors src/standings-lives.ts EXACTLY -- if you change one copy, change both.

import { computeNetLives, type StandingRow, type PairingWithLives } from "@/lib/standings";

// Attaches netLives/livesGamesMissing (via the same computeNetLives the
// "lives" tiebreak uses) to every row that has played at least one match.
// Rows with nothing played are left completely untouched -- no netLives/
// livesGamesMissing keys at all -- so a division with no results comes back
// byte-for-byte identical to its input. Lives used to attach to tied rows
// only, which left the winner of a 2-0 with no lives shown while the loser
// showed -8. Mutates + returns `rows`, mirroring assignRanks's convention.
export function attachNetLives(
  rows: StandingRow[],
  pairings: Array<Pick<PairingWithLives, "playerAId" | "playerBId" | "games">>,
): StandingRow[] {
  rows.forEach((row) => {
    if (row.played === 0) return;
    const { netLives, livesGamesMissing } = computeNetLives(row.player.id, pairings);
    row.netLives = netLives;
    row.livesGamesMissing = livesGamesMissing;
  });
  return rows;
}
