// Pure functions for computing standings. Mirrors the bot's src/standings.ts.

import type { Match, Player } from "@prisma/client";
import { DEFAULTS, type ScoringConfig } from "@/lib/league-settings";

export interface StandingRow {
  player: Player;
  points: number;
  wins: number;       // 2-0 results
  draws: number;      // 1-1 results
  losses: number;     // 0-2 results
  gamesWon: number;
  gamesLost: number;
  played: number;     // confirmed pairings
  dropped?: boolean;
  // Set only under a best-N scoring mode (see standings-best-n.ts /
  // standings-cache.ts): how many of this player's results counted toward
  // their standing, and the cap ("of") selection was made against. Absent
  // under "all" mode.
  counted?: number;
  of?: number;
  // True when this row ties with the row above on points/wins/draws AND
  // no shootout has been recorded between them. UI shows a ⚔ marker
  // prompting admin to record one (or for players to play + report).
  tiedWithPrev?: boolean;
  tiedWithNext?: boolean;
  // Standard competition ranking ("1224"): genuinely-tied players SHARE a rank
  // instead of being force-ordered alphabetically. The row order is still
  // deterministic (alphabetical within a tie group) for stable display.
  rank?: number;
  // Only set when computeStandings/computeBestNStandings was called with
  // tiebreak: "lives" -- net life differential (livesInWins - livesConceded,
  // see computeNetLives) from this row's counted games that have a recorded
  // winnerLives. Absent entirely under the default "chain" tiebreak so chain
  // output stays byte-for-byte identical to before this field existed.
  netLives?: number;
  // How many of this row's counted games lack a recorded winnerLives (so the
  // UI can say "N games without lives"). Only set alongside netLives.
  livesGamesMissing?: number;
}

// "chain" (default): today's tiebreak order -- points, head-to-head,
// shootout, wins, draws, name. "lives" inserts net-lives comparison (see
// computeNetLives) between shootout and wins/draws/name, for the admin
// standings-preview page's "break 3+-way ties by net lives instead of by
// hand" preview (web/app/admin/standings-preview). Not wired into live
// standings anywhere -- see standings-best-n.ts's TODO for where a
// season-level setting would eventually plug in.
export type Tiebreak = "chain" | "lives";

// One game's life data as needed for the net-lives tiebreak, independent of
// deck/stake/num -- the subset of a Game row computeNetLives reads.
export interface PairingGameLives {
  winnerId: string | null;
  winnerLives: number | null;
}

// A pairing shape carrying its per-game lives data, used by computeStandings
// / computeBestNStandings and computeNetLives below. `games` is optional so
// every existing caller that doesn't supply per-game lives data keeps
// working unchanged (net lives for such pairings is simply 0, no missing
// count -- there's nothing to be missing).
export type PairingWithLives = Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB"> & {
  games?: PairingGameLives[];
};

// Net life differential for one player across the given pairings: the sum of
// the winner's remaining lives in games they won, minus the sum of the
// winner's remaining lives in games they lost (i.e. the opponent's remaining
// lives). A game with no winnerId (indeterminate) is skipped entirely; a
// game with a winnerId but no recorded winnerLives contributes 0 to netLives
// and increments livesGamesMissing instead. Pure: no I/O, just the supplied
// pairings' games data. Callers are expected to pass only this player's own
// COUNTED pairings (all of them, under "chain"/plain standings; the best-N
// selection's countedResults under best-N) -- computeNetLives itself has no
// opinion on what "counted" means, it just sums whatever pairings it's given
// that mention the player.
export function computeNetLives(
  playerId: string,
  pairings: Array<Pick<PairingWithLives, "playerAId" | "playerBId" | "games">>,
): { netLives: number; livesGamesMissing: number } {
  let netLives = 0;
  let livesGamesMissing = 0;
  for (const pr of pairings) {
    if (pr.playerAId !== playerId && pr.playerBId !== playerId) continue;
    for (const g of pr.games ?? []) {
      if (!g.winnerId) continue; // indeterminate game -- not part of net lives
      if (g.winnerLives == null) {
        livesGamesMissing++;
        continue;
      }
      netLives += g.winnerId === playerId ? g.winnerLives : -g.winnerLives;
    }
  }
  return { netLives, livesGamesMissing };
}

// Assign display ranks via standard competition ranking: tied rows (tiedWithPrev)
// share the rank of the group's first row; the next distinct group resumes at
// its positional index (1, 2, 2, 4). Sets tiedWithNext so a row knows it's part
// of a tie from the upper side too. Expects rows already sorted + tied-marked.
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

// Display label for a standing row's rank: a plain number (1, 2, 3, …). Ties
// share the SAME number prefixed "#" on every tied row (e.g. "#1 #1 #1" for a
// 3-way tie) — that's the visible "real tie". (Card-themed labels are for the
// DIVISION names, not the in-division leaderboard.)
export function rankLabel(
  row: { rank?: number; tiedWithPrev?: boolean; tiedWithNext?: boolean },
  fallbackIndex: number,
): string {
  const n = row.rank ?? fallbackIndex + 1;
  if (row.tiedWithPrev || row.tiedWithNext) return `#${n}`;
  return `${n}`;
}

export interface ShootoutInput {
  playerAId: string;
  playerBId: string;
  winnerId: string;
}

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
      points: 0, wins: 0, draws: 0, losses: 0,
      gamesWon: 0, gamesLost: 0, played: 0,
    });
  }

  for (const pr of pairings) {
    const a = byId.get(pr.playerAId);
    const b = byId.get(pr.playerBId);
    if (!a || !b) continue;
    a.played++; b.played++;
    a.gamesWon += pr.gamesWonA; a.gamesLost += pr.gamesWonB;
    b.gamesWon += pr.gamesWonB; b.gamesLost += pr.gamesWonA;

    if (pr.gamesWonA === 2 && pr.gamesWonB === 0) {
      a.points += scoring.pointsFor20Win;
      b.points += scoring.pointsForLoss;
      a.wins++; b.losses++;
    } else if (pr.gamesWonA === 0 && pr.gamesWonB === 2) {
      b.points += scoring.pointsFor20Win;
      a.points += scoring.pointsForLoss;
      b.wins++; a.losses++;
    } else if (pr.gamesWonA === 1 && pr.gamesWonB === 1) {
      a.points += scoring.pointsFor11Draw;
      b.points += scoring.pointsFor11Draw;
      a.draws++; b.draws++;
    }
  }

  return sortStandings(Array.from(byId.values()), pairings, shootouts, tiebreak);
}

// Sort: points DESC -> head-to-head (if tied players already played) ->
// shootout result -> [tiebreak "lives" only: net lives DESC] -> wins DESC ->
// draws DESC -> displayName for stable order. Unbreakable ties (after all
// tiebreakers, including any recorded shootout and, under "lives", net
// lives) are flagged via tiedWithPrev so UI can render the tie marker.
function sortStandings(
  rows: StandingRow[],
  pairings: Array<PairingWithLives>,
  shootouts: ShootoutInput[],
  tiebreak: Tiebreak,
): StandingRow[] {
  // Only attach netLives/livesGamesMissing under "lives" -- keeps "chain"
  // output exactly as it was before this field existed (no extra keys on
  // the row at all), which is what the chain-mode-unchanged property relies
  // on.
  if (tiebreak === "lives") {
    for (const row of rows) {
      const { netLives, livesGamesMissing } = computeNetLives(row.player.id, pairings);
      row.netLives = netLives;
      row.livesGamesMissing = livesGamesMissing;
    }
  }
  const livesCompare = (x: StandingRow, y: StandingRow): number =>
    tiebreak === "lives" ? (y.netLives ?? 0) - (x.netLives ?? 0) : 0;

  const sorted = rows.slice().sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    const h2h = headToHead(x.player.id, y.player.id, pairings);
    if (h2h !== 0) return h2h;
    const shoot = shootoutBetween(x.player.id, y.player.id, shootouts);
    if (shoot !== 0) return shoot;
    const lives = livesCompare(x, y);
    if (lives !== 0) return lives;
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.draws !== x.draws) return y.draws - x.draws;
    return x.player.displayName.localeCompare(y.player.displayName);
  });
  // Mark rows tied on the entire chain — shootout-eligible territory.
  // If a shootout exists for the pair, h2h/wins/draws being equal but
  // shootout differing would have already separated them above; reaching
  // here means no shootout exists or it didn't break the tie.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (
      prev.points === cur.points &&
      headToHead(prev.player.id, cur.player.id, pairings) === 0 &&
      shootoutBetween(prev.player.id, cur.player.id, shootouts) === 0 &&
      livesCompare(prev, cur) === 0 &&
      prev.wins === cur.wins &&
      prev.draws === cur.draws
    ) {
      cur.tiedWithPrev = true;
    }
  }
  return assignRanks(sorted);
}

// Exported (alongside headToHead below) so web/lib/standings-best-n.ts can
// reuse the exact same tiebreak primitives instead of duplicating them.
export function shootoutBetween(xId: string, yId: string, shootouts: ShootoutInput[]): number {
  const found = shootouts.find(
    (s) =>
      (s.playerAId === xId && s.playerBId === yId) ||
      (s.playerAId === yId && s.playerBId === xId),
  );
  if (!found) return 0;
  if (found.winnerId === xId) return -1;
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
  // 2-0 only — a 1-1 doesn't break the tie
  if (xGames === 2 && yGames === 0) return -1;
  if (yGames === 2 && xGames === 0) return 1;
  return 0;
}
