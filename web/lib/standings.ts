// Pure functions for computing standings. Mirrors the bot's src/standings.ts.

import type { Pairing, Player } from "@prisma/client";

const POINTS_FOR_2_0_WIN = 3;
const POINTS_FOR_1_1_DRAW = 1;

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
  // True when this row ties with the row above on points/wins/draws.
  // Set by sortStandings; UI shows a marker so admin can manually break the tie.
  tiedWithPrev?: boolean;
}

export function computeStandings(
  players: Player[],
  pairings: Array<Pick<Pairing, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
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
      a.points += POINTS_FOR_2_0_WIN; a.wins++; b.losses++;
    } else if (pr.gamesWonA === 0 && pr.gamesWonB === 2) {
      b.points += POINTS_FOR_2_0_WIN; b.wins++; a.losses++;
    } else if (pr.gamesWonA === 1 && pr.gamesWonB === 1) {
      a.points += POINTS_FOR_1_1_DRAW; b.points += POINTS_FOR_1_1_DRAW;
      a.draws++; b.draws++;
    }
  }

  return sortStandings(Array.from(byId.values()), pairings);
}

// Sort: points DESC → wins (2-0 count) DESC → draws (1-1 count) DESC
// → stable by displayName so tied rows have a deterministic order.
// Unbreakable ties (same pts/wins/draws) are flagged via tiedWithPrev
// so the UI can show them and admin can manually shuffle if needed.
function sortStandings(
  rows: StandingRow[],
  _pairings: Array<Pick<Pairing, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
): StandingRow[] {
  void _pairings;
  const sorted = rows.slice().sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.draws !== x.draws) return y.draws - x.draws;
    return x.player.displayName.localeCompare(y.player.displayName);
  });
  // Flag rows that tie with the previous row on the substantive metrics.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.points === cur.points && prev.wins === cur.wins && prev.draws === cur.draws) {
      cur.tiedWithPrev = true;
    }
  }
  return sorted;
}
