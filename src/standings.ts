// Standings calculation. Pure function over confirmed pairings — easy to unit-test and reuse
// from /standings, /admin previews, the sim script, and end-of-season promotion logic.

import type { Match, Player } from "@prisma/client";
import { DEFAULTS, type ScoringConfig } from "./league-settings.js";
import { sanitizeName } from "./sanitize.js";

export interface StandingRow {
  player: Player;
  points: number;
  wins: number;       // 2-0 results
  draws: number;      // 1-1 results
  losses: number;     // 0-2 results
  gamesWon: number;
  gamesLost: number;
  played: number;     // confirmed pairings
  dropped?: boolean;  // marked when this row's member status is DROPPED
  // Set only under a best-N scoring mode -- how many of this player's
  // results counted toward their standing, and the cap ("of") selection was
  // made against. Absent under "all" mode. Mirrors web.
  counted?: number;
  of?: number;
  // Ties are real: players equal on the whole chain (no shootout) SHARE a rank
  // rather than being force-ordered alphabetically. tiedWithPrev/Next mark the
  // group; rank is standard competition ranking (1, 2, 2, 4). Mirrors web.
  tiedWithPrev?: boolean;
  tiedWithNext?: boolean;
  rank?: number;
  // Only set when computeStandings was called with tiebreak: "lives" -- net
  // life differential from this row's counted games with a recorded
  // winnerLives. Absent under the default "chain" tiebreak. Mirrors web
  // (web/lib/standings.ts), currently unused by any bot caller -- nothing in
  // the bot calls computeStandings with tiebreak: "lives" yet; this mirrors
  // the web admin-preview feature's core so the two copies don't drift.
  netLives?: number;
  livesGamesMissing?: number;
  // Only set under tiebreak "lives", and only on a row that was part of an
  // EXACTLY-TWO-tied points group whose two members actually played each
  // other -- the signed lives differential from THIS row's own perspective
  // across that one match's games (see headToHeadLivesDiff). Informational
  // (the UI can show it); absent for every other row. Mirrors web
  // (web/lib/standings.ts).
  h2hLives?: number;
}

// See web/lib/standings.ts's identical type for the full rationale.
export type Tiebreak = "chain" | "lives";

export interface PairingGameLives {
  winnerId: string | null;
  winnerLives: number | null;
}

export type PairingWithLives = Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB"> & {
  games?: PairingGameLives[];
};

// Mirrors web/lib/standings.ts's computeNetLives verbatim.
export function computeNetLives(
  playerId: string,
  pairings: Array<Pick<PairingWithLives, "playerAId" | "playerBId" | "games">>,
): { netLives: number; livesGamesMissing: number } {
  let netLives = 0;
  let livesGamesMissing = 0;
  for (const pr of pairings) {
    if (pr.playerAId !== playerId && pr.playerBId !== playerId) continue;
    for (const g of pr.games ?? []) {
      if (!g.winnerId) continue;
      if (g.winnerLives == null) {
        livesGamesMissing++;
        continue;
      }
      netLives += g.winnerId === playerId ? g.winnerLives : -g.winnerLives;
    }
  }
  return { netLives, livesGamesMissing };
}

export interface ShootoutInput {
  playerAId: string;
  playerBId: string;
  winnerId: string;
}

// Standard competition ranking: tied rows (tiedWithPrev) share the group's
// first rank; the next distinct group resumes at its positional index. Sets
// tiedWithNext. Expects rows already sorted + tied-marked.
export function assignRanks(rows: StandingRow[]): StandingRow[] {
  rows.forEach((cur, i) => {
    if (i === 0) {
      cur.rank = 1;
      return;
    }
    const prev = rows[i - 1]!;
    if (cur.tiedWithPrev) {
      cur.rank = prev.rank;
      prev.tiedWithNext = true;
    } else {
      cur.rank = i + 1;
    }
  });
  return rows;
}

// A tie the season can't resolve on its own that lands ON a consequential
// boundary — the two players must play a single shootout game to decide who
// takes the promotion (or avoids the relegation) spot.
export interface ShootoutNeed {
  aId: string;
  bId: string;
  boundary: "promotion" | "relegation";
}

// End-of-division shootout detection over ALREADY-RANKED rows (computeStandings
// output). A shootout is owed only when a tie group of EXACTLY TWO straddles the
// promotion or relegation cutoff:
//   - Being a 2-player tie group already means their head-to-head is unresolved
//     (split 1-1 or unplayed) AND no shootout has been played — either would have
//     separated them in the sort, so they wouldn't share a rank. So "still tied"
//     == "shootout owed, not yet played". No extra h2h check needed.
//   - 3-or-more-way ties are settled by net lives, NOT a shootout — skipped here.
// `promote`/`relegate` are this division's movement counts (0 when a boundary
// doesn't exist, e.g. the top division never promotes / the bottom never relegates).
export function shootoutsNeeded(rows: StandingRow[], promote: number, relegate: number): ShootoutNeed[] {
  const active = rows.filter((r) => !r.dropped);
  const n = active.length;
  const needs: ShootoutNeed[] = [];

  // A boundary sits between sorted positions cutoff-1 and cutoff (1-indexed by
  // how many players are on the top side). Returns the straddling pair only when
  // exactly two players share the rank spanning it.
  const straddle = (cutoff: number): [StandingRow, StandingRow] | null => {
    if (cutoff <= 0 || cutoff >= n) return null;
    const hi = active[cutoff - 1]!;
    const lo = active[cutoff]!;
    if (hi.rank == null || hi.rank !== lo.rank) return null; // no tie across the line
    if (active.filter((r) => r.rank === hi.rank).length !== 2) return null; // 3+ -> net lives
    return [hi, lo];
  };

  const promo = straddle(promote);
  if (promo) needs.push({ aId: promo[0].player.id, bId: promo[1].player.id, boundary: "promotion" });

  const releg = straddle(n - relegate);
  if (releg) {
    const dup = needs.some(
      (x) =>
        (x.aId === releg[0].player.id && x.bId === releg[1].player.id) ||
        (x.aId === releg[1].player.id && x.bId === releg[0].player.id),
    );
    if (!dup) needs.push({ aId: releg[0].player.id, bId: releg[1].player.id, boundary: "relegation" });
  }
  return needs;
}

// Confirmed-only. Status filtering is the caller's job. Shootouts (when
// supplied) break ties that points + h2h can't resolve — winner sorts
// above loser. scoring is optional; admin-tunable per LeagueSettings,
// defaults to 3/1/0 when not passed (sim/legacy callers).
export function computeStandings(
  players: Player[],
  pairings: Array<PairingWithLives>,
  shootouts: ShootoutInput[] = [],
  scoring: ScoringConfig = DEFAULTS.scoring,
  tiebreak: Tiebreak = "chain",
): StandingRow[] {
  const byId = new Map<string, StandingRow>();
  for (const p of players) {
    byId.set(p.id, {
      player: p,
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      gamesWon: 0,
      gamesLost: 0,
      played: 0,
    });
  }

  for (const pr of pairings) {
    const a = byId.get(pr.playerAId);
    const b = byId.get(pr.playerBId);
    if (!a || !b) continue; // pairing references a player not in the supplied set; skip

    a.played++;
    b.played++;
    a.gamesWon += pr.gamesWonA;
    a.gamesLost += pr.gamesWonB;
    b.gamesWon += pr.gamesWonB;
    b.gamesLost += pr.gamesWonA;

    if (pr.gamesWonA === 2 && pr.gamesWonB === 0) {
      a.points += scoring.pointsFor20Win;
      b.points += scoring.pointsForLoss;
      a.wins++;
      b.losses++;
    } else if (pr.gamesWonA === 0 && pr.gamesWonB === 2) {
      b.points += scoring.pointsFor20Win;
      a.points += scoring.pointsForLoss;
      b.wins++;
      a.losses++;
    } else if (pr.gamesWonA === 1 && pr.gamesWonB === 1) {
      a.points += scoring.pointsFor11Draw;
      b.points += scoring.pointsFor11Draw;
      a.draws++;
      b.draws++;
    }
    // any other combination is malformed; ignore.
  }

  return sortStandings(Array.from(byId.values()), pairings, shootouts, tiebreak);
}

// Sort rules (tiebreak "chain", the default): points DESC -> head-to-head
// (2-0 only) -> shootout result -> wins DESC -> draws DESC -> displayName
// for stable order. This is the ORIGINAL chain-mode algorithm, untouched by
// the "lives" tiebreak below. Mirrors web/lib/standings.ts.
//
// Under tiebreak "lives" every row first gets netLives/livesGamesMissing
// (as before), then ordering is delegated entirely to sortStandingsLives --
// a different grouping algorithm (see its header), NOT this pairwise
// comparator. The chain path never sees a "lives" branch inserted into it.
function sortStandings(
  rows: StandingRow[],
  pairings: Array<PairingWithLives>,
  shootouts: ShootoutInput[],
  tiebreak: Tiebreak,
): StandingRow[] {
  if (tiebreak === "lives") {
    for (const row of rows) {
      const { netLives, livesGamesMissing } = computeNetLives(row.player.id, pairings);
      row.netLives = netLives;
      row.livesGamesMissing = livesGamesMissing;
    }
    const ordered = sortStandingsLives(
      rows,
      (xId, yId) => shootoutBetween(xId, yId, shootouts),
      (xId, yId) => headToHeadLivesDiff(xId, yId, pairings),
    );
    return assignRanks(ordered);
  }

  const sorted = rows.slice().sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    const h2h = headToHead(x.player.id, y.player.id, pairings);
    if (h2h !== 0) return h2h;
    const shoot = shootoutBetween(x.player.id, y.player.id, shootouts);
    if (shoot !== 0) return shoot;
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.draws !== x.draws) return y.draws - x.draws;
    return x.player.displayName.localeCompare(y.player.displayName);
  });
  // Flag rows tied on the whole chain (alphabetical broke the row order only,
  // not the ranking) so they can SHARE a rank.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (
      prev.points === cur.points &&
      headToHead(prev.player.id, cur.player.id, pairings) === 0 &&
      shootoutBetween(prev.player.id, cur.player.id, shootouts) === 0 &&
      prev.wins === cur.wins &&
      prev.draws === cur.draws
    ) {
      cur.tiedWithPrev = true;
    }
  }
  return assignRanks(sorted);
}

// Signed lives differential between two players from their SINGLE pairing's
// per-game winnerLives (a game's winner's recorded winnerLives counts FOR
// them and AGAINST the loser, so a 2-0 naturally outweighs a 1-1 split; a
// game missing winnerLives contributes 0, same as computeNetLives). Returns
// null when the two never played each other at all, so the caller can tell
// "didn't play" (-> fall back to total net lives) apart from "played and
// netted exactly zero" (a real 0). Exported so standings-best-n.ts can reuse
// it with its own "both sides counted this result" gating. Mirrors
// web/lib/standings.ts's identical export.
export function headToHeadLivesDiff(
  xId: string,
  yId: string,
  pairings: Array<Pick<PairingWithLives, "playerAId" | "playerBId" | "games">>,
): number | null {
  const meeting = pairings.find(
    (p) => (p.playerAId === xId && p.playerBId === yId) || (p.playerAId === yId && p.playerBId === xId),
  );
  if (!meeting) return null;
  let diff = 0;
  for (const g of meeting.games ?? []) {
    if (!g.winnerId) continue;
    if (g.winnerLives == null) continue;
    diff += g.winnerId === xId ? g.winnerLives : -g.winnerLives;
  }
  return diff;
}

// Display-only secondary order within a group that's otherwise fully tied
// (wins DESC, draws DESC, name ASC) -- never used to BREAK the tie, only to
// give tied rows a stable, deterministic row order. Exported alongside
// sortStandingsLives/orderLivesPointsGroup for direct unit testing. Mirrors
// web/lib/standings.ts's identical export.
export function livesDisplayOrder<T extends StandingRow>(rows: T[]): T[] {
  return rows.slice().sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.draws !== x.draws) return y.draws - x.draws;
    return x.player.displayName.localeCompare(y.player.displayName);
  });
}

// The "lives" tiebreak's rule for ONE group of rows already tied on points
// (and nothing else -- sortStandingsLives below forms these groups). Mutates
// tiedWithPrev (and, for an exactly-two group, h2hLives) directly on the
// rows it returns in their final order, mirroring assignRanks's convention.
// Exported for direct unit testing. Mirrors web/lib/standings.ts's identical
// export.
//
//   - 1 player: nothing to decide.
//   - 3+ players: order by total net lives DESC. Players still equal after
//     that are a REAL tie (tiedWithPrev) sharing a rank -- wins/draws/name
//     only pick a stable DISPLAY order among them, never break the tie.
//   - exactly 2 players: (1) a CONFIRMED shootout between them decides;
//     else (2) if they played each other, the lives differential INSIDE
//     that one match decides (h2hLives is recorded on both rows whenever
//     they played, whether or not it ends up deciding anything); else, or
//     if that differential is exactly zero, (3) total net lives decides;
//     still equal -> REAL tie, same as the 3+ case.
export function orderLivesPointsGroup<T extends StandingRow>(
  group: T[],
  shootoutBetween: (xId: string, yId: string) => number,
  h2hLivesDiff: (xId: string, yId: string) => number | null,
): T[] {
  if (group.length <= 1) return group.slice();

  if (group.length === 2) {
    const [a, b] = group as [T, T];
    const shoot = shootoutBetween(a.player.id, b.player.id);
    if (shoot !== 0) return shoot < 0 ? [a, b] : [b, a];

    const diff = h2hLivesDiff(a.player.id, b.player.id);
    if (diff !== null) {
      a.h2hLives = diff;
      b.h2hLives = diff === 0 ? 0 : -diff; // avoid -0 when the match netted exactly even
      if (diff !== 0) return diff > 0 ? [a, b] : [b, a];
    }

    const na = a.netLives ?? 0;
    const nb = b.netLives ?? 0;
    if (na !== nb) return na > nb ? [a, b] : [b, a];

    const ordered = livesDisplayOrder([a, b]);
    const first = ordered[0]!;
    const second = ordered[1]!;
    second.tiedWithPrev = true;
    return [first, second];
  }

  const byLives = group.slice().sort((x, y) => {
    const diff = (y.netLives ?? 0) - (x.netLives ?? 0);
    if (diff !== 0) return diff;
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.draws !== x.draws) return y.draws - x.draws;
    return x.player.displayName.localeCompare(y.player.displayName);
  });
  for (let i = 1; i < byLives.length; i++) {
    if ((byLives[i]!.netLives ?? 0) === (byLives[i - 1]!.netLives ?? 0)) {
      byLives[i]!.tiedWithPrev = true;
    }
  }
  return byLives;
}

// Top-level tiebreak "lives" ordering: group rows by equal points (best
// group first), then order each group via orderLivesPointsGroup. Points
// alone decide group membership, so two rows in different groups are never
// tied (matches tiedWithPrev's existing "equal on everything above it"
// meaning) -- the caller still needs to assignRanks afterward, same as the
// chain path. Pure: both comparison functions are closures the caller
// builds over its own pairings/shootouts (and, for best-N, its own
// counted-results gating) -- this function touches neither directly.
// Exported for direct unit testing. Mirrors web/lib/standings.ts's
// identical export.
export function sortStandingsLives<T extends StandingRow>(
  rows: T[],
  shootoutBetween: (xId: string, yId: string) => number,
  h2hLivesDiff: (xId: string, yId: string) => number | null,
): T[] {
  const byPoints = rows.slice().sort((x, y) => y.points - x.points);
  const result: T[] = [];
  let i = 0;
  while (i < byPoints.length) {
    let j = i + 1;
    while (j < byPoints.length && byPoints[j]!.points === byPoints[i]!.points) j++;
    result.push(...orderLivesPointsGroup(byPoints.slice(i, j), shootoutBetween, h2hLivesDiff));
    i = j;
  }
  return result;
}

// Exported (alongside headToHead below) so src/standings-best-n.ts can reuse
// the exact same tiebreak primitives instead of duplicating them. Mirrors
// web/lib/standings.ts's identical exports.
export function shootoutBetween(xId: string, yId: string, shootouts: ShootoutInput[]): number {
  const found = shootouts.find(
    (s) =>
      (s.playerAId === xId && s.playerBId === yId) ||
      (s.playerAId === yId && s.playerBId === xId),
  );
  if (!found) return 0;
  if (found.winnerId === xId) return -1; // x sorts above y
  if (found.winnerId === yId) return 1;
  return 0;
}

// Returns negative if x should sort BEFORE y (x won their match), positive
// if y should sort before x, 0 if they haven't played or drew.
export function headToHead(
  xId: string,
  yId: string,
  pairings: Array<Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
): number {
  const meeting = pairings.find(
    (p) => (p.playerAId === xId && p.playerBId === yId) || (p.playerAId === yId && p.playerBId === xId),
  );
  if (!meeting) return 0;
  const xIsA = meeting.playerAId === xId;
  const xGames = xIsA ? meeting.gamesWonA : meeting.gamesWonB;
  const yGames = xIsA ? meeting.gamesWonB : meeting.gamesWonA;
  if (xGames === 2 && yGames === 0) return -1;
  if (yGames === 2 && xGames === 0) return 1;
  return 0;
}

// Formatting helper shared by /standings and admin previews. Kept for compact text use.
export function formatStandingsTable(divisionName: string, rows: StandingRow[]): string {
  const header = `**${divisionName} — Standings**`;
  if (rows.length === 0) return `${header}\n_(no players)_`;

  const lines = rows.map((r, i) => {
    const n = r.rank ?? i + 1;
    const tied = r.tiedWithPrev || r.tiedWithNext;
    const rank = `${tied ? `#${n}` : `${n}.`}`.padEnd(3);
    // Inside a ``` code block markdown doesn't render, but backticks could still
    // break the fence — neutralize them (don't escape, that'd show ugly \` here).
    const name = r.player.displayName.replace(/`/g, "'").padEnd(16);
    const pts = `${r.points}p`.padStart(4);
    const record = `${r.wins}W-${r.draws}D-${r.losses}L`.padEnd(8);
    const games = `(${r.gamesWon}-${r.gamesLost} games)`;
    return `${rank} ${name} ${pts}  ${record}  ${games}`;
  });
  return `${header}\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

// Compact one-line-per-player rendering used in embed fields.
export function formatDivisionField(rows: StandingRow[], expectedSize: number): string {
  if (rows.length === 0) return "_(no players)_";
  return rows
    .map((r, i) => {
      const n = r.rank ?? i + 1;
      const tied = r.tiedWithPrev || r.tiedWithNext;
      // Plain numbers; tied players share a rank shown as `#2`.
      const prefix = tied
        ? `\`#${n.toString().padStart(2)}\``
        : `\`${n.toString().padStart(2)}.\``;
      const stats = `**${r.points}** pts · ${r.wins}-${r.draws}-${r.losses} · ${r.gamesWon}-${r.gamesLost} g`;
      const name = r.dropped ? `~~${sanitizeName(r.player.displayName)}~~ _(dropped)_` : sanitizeName(r.player.displayName);
      return `${prefix} ${name} — ${stats}`;
    })
    .join("\n") + (rows.length < expectedSize ? `\n_${expectedSize - rows.length} seat(s) open_` : "");
}
