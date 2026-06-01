// Standings calculation. Pure function over confirmed pairings — easy to unit-test and reuse
// from /standings, /admin previews, the sim script, and end-of-season promotion logic.

import type { Pairing, Player } from "@prisma/client";
import { DEFAULTS, type ScoringConfig } from "./league-settings.js";

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

export interface ShootoutInput {
  playerAId: string;
  playerBId: string;
  winnerId: string;
}

// Confirmed-only. Status filtering is the caller's job. Shootouts (when
// supplied) break ties that points + h2h can't resolve — winner sorts
// above loser. scoring is optional; admin-tunable per LeagueSettings,
// defaults to 3/1/0 when not passed (sim/legacy callers).
export function computeStandings(
  players: Player[],
  pairings: Array<Pick<Pairing, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
  shootouts: ShootoutInput[] = [],
  scoring: ScoringConfig = DEFAULTS.scoring,
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

  return sortStandings(Array.from(byId.values()), pairings, shootouts);
}

// Sort rules: points DESC → head-to-head (2-0 only) → shootout result →
// wins DESC → draws DESC → displayName for stable order. Mirrors
// web/lib/standings.ts.
function sortStandings(
  rows: StandingRow[],
  pairings: Array<Pick<Pairing, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
  shootouts: ShootoutInput[],
): StandingRow[] {
  return rows.slice().sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    const h2h = headToHead(x.player.id, y.player.id, pairings);
    if (h2h !== 0) return h2h;
    const shoot = shootoutBetween(x.player.id, y.player.id, shootouts);
    if (shoot !== 0) return shoot;
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.draws !== x.draws) return y.draws - x.draws;
    return x.player.displayName.localeCompare(y.player.displayName);
  });
}

function shootoutBetween(xId: string, yId: string, shootouts: ShootoutInput[]): number {
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

function headToHead(
  xId: string,
  yId: string,
  pairings: Array<Pick<Pairing, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">>,
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
