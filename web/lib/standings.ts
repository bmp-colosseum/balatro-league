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
  // True when this row ties with the row above on points/wins/draws AND
  // no shootout has been recorded between them. UI shows a ⚔ marker
  // prompting admin to record one (or for players to play + report).
  tiedWithPrev?: boolean;
  tiedWithNext?: boolean;
  // Standard competition ranking ("1224"): genuinely-tied players SHARE a rank
  // instead of being force-ordered alphabetically. The row order is still
  // deterministic (alphabetical within a tie group) for stable display.
  rank?: number;
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

// Display label for a standing row's rank: a medal for a clean top-3, the
// shared number prefixed "T" for a genuine tie (e.g. "T3"), else "N.". Ties
// show the SAME number on every tied row — that's the visible "real tie".
export function rankLabel(
  row: { rank?: number; tiedWithPrev?: boolean; tiedWithNext?: boolean },
  fallbackIndex: number,
): string {
  const n = row.rank ?? fallbackIndex + 1;
  // Tied players share their rank shown as "#N" (e.g. #1 #1 #1 for a 3-way
  // tie). Clean top-3 get a medal; everyone else a plain "N.".
  if (row.tiedWithPrev || row.tiedWithNext) return `#${n}`;
  if (n <= 3) return ["🥇", "🥈", "🥉"][n - 1]!;
  return `${n}.`;
}

export interface ShootoutInput {
  playerAId: string;
  playerBId: string;
  winnerId: string;
}

export function computeStandings(
  players: Player[],
  pairings: Array<Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
  shootouts: ShootoutInput[] = [],
  scoring: ScoringConfig = DEFAULTS.scoring,
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

  return sortStandings(Array.from(byId.values()), pairings, shootouts);
}

// Sort: points DESC → head-to-head (if tied players already played) →
// shootout result → wins DESC → draws DESC → displayName for stable
// order. Unbreakable ties (after all tiebreakers, including any recorded
// shootout) are flagged via tiedWithPrev so UI can render the ⚔ marker.
function sortStandings(
  rows: StandingRow[],
  pairings: Array<Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
  shootouts: ShootoutInput[],
): StandingRow[] {
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
      prev.wins === cur.wins &&
      prev.draws === cur.draws
    ) {
      cur.tiedWithPrev = true;
    }
  }
  return assignRanks(sorted);
}

function shootoutBetween(xId: string, yId: string, shootouts: ShootoutInput[]): number {
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
function headToHead(
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
