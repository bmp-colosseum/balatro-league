// Standings calculation. Pure function over confirmed pairings — easy to unit-test and reuse
// from /standings, /admin previews, the sim script, and end-of-season promotion logic.

import type { Pairing, Player } from "@prisma/client";
import { POINTS_FOR_1_1_DRAW, POINTS_FOR_2_0_WIN } from "./scoring.js";

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
}

// Confirmed-only. Status filtering is the caller's job.
export function computeStandings(
  players: Player[],
  pairings: Array<Pick<Pairing, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
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
      a.points += POINTS_FOR_2_0_WIN;
      a.wins++;
      b.losses++;
    } else if (pr.gamesWonA === 0 && pr.gamesWonB === 2) {
      b.points += POINTS_FOR_2_0_WIN;
      b.wins++;
      a.losses++;
    } else if (pr.gamesWonA === 1 && pr.gamesWonB === 1) {
      a.points += POINTS_FOR_1_1_DRAW;
      b.points += POINTS_FOR_1_1_DRAW;
      a.draws++;
      b.draws++;
    }
    // any other combination is malformed; ignore.
  }

  return sortStandings(Array.from(byId.values()), pairings);
}

// Sort rules: points DESC → wins (2-0 count) DESC → draws (1-1 count) DESC
// → displayName for a stable tiebreak. Unbreakable ties (same pts/wins/
// draws) are admin-resolved manually.
function sortStandings(
  rows: StandingRow[],
  _pairings: Array<Pick<Pairing, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
): StandingRow[] {
  void _pairings;
  return rows.slice().sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.draws !== x.draws) return y.draws - x.draws;
    return x.player.displayName.localeCompare(y.player.displayName);
  });
}

// Formatting helper shared by /standings and admin previews. Kept for compact text use.
export function formatStandingsTable(divisionName: string, rows: StandingRow[]): string {
  const header = `**${divisionName} — Standings**`;
  if (rows.length === 0) return `${header}\n_(no players)_`;

  const lines = rows.map((r, i) => {
    const rank = `${i + 1}.`.padEnd(3);
    const name = r.player.displayName.padEnd(16);
    const pts = `${r.points}p`.padStart(4);
    const record = `${r.wins}W-${r.draws}D-${r.losses}L`.padEnd(8);
    const games = `(${r.gamesWon}-${r.gamesLost} games)`;
    return `${rank} ${name} ${pts}  ${record}  ${games}`;
  });
  return `${header}\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

const MEDAL = ["🥇", "🥈", "🥉"];

// Compact one-line-per-player rendering used in embed fields.
export function formatDivisionField(rows: StandingRow[], expectedSize: number): string {
  if (rows.length === 0) return "_(no players)_";
  return rows
    .map((r, i) => {
      const prefix = i < MEDAL.length ? MEDAL[i] : `\`${(i + 1).toString().padStart(2)}.\``;
      const stats = `**${r.points}** pts · ${r.wins}-${r.draws}-${r.losses} · ${r.gamesWon}-${r.gamesLost} g`;
      const name = r.dropped ? `~~${r.player.displayName}~~ _(dropped)_` : r.player.displayName;
      return `${prefix} ${name} — ${stats}`;
    })
    .join("\n") + (rows.length < expectedSize ? `\n_${expectedSize - rows.length} seat(s) open_` : "");
}
