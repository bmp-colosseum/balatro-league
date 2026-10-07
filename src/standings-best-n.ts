// Pure core for the "best N" dropout-adjusted standings engine. Mirrors
// web/lib/standings-best-n.ts EXACTLY (same algorithm, same tiebreak
// primitives from ./standings.js, which mirrors web/lib/standings.ts) so the
// bot's live standings post and the web's live standings path can never
// silently disagree about what a season with scoringMode "best-n-count" /
// "best-n-void" looks like. If you change one copy, change both.
//
// See web/lib/standings-best-n.ts's header for the full rule writeup (best-N
// selection, the "count" vs "void" dropoutGames variants, tiebreak scoping).
// buildBestNMembers below also mirrors that file's loader-side member
// assembly (the isReplacement heuristic + scheduledGames cap), pulled in
// here as a pure function so src/standings-cache.ts doesn't duplicate it.

import type { Match, Player } from "@prisma/client";
import { DEFAULTS, type ScoringConfig } from "./league-settings.js";
import {
  type StandingRow,
  type ShootoutInput,
  computeStandings,
  assignRanks,
  headToHead,
  shootoutBetween,
} from "./standings.js";

export type BestNPairing = Pick<Match, "playerAId" | "playerBId" | "gamesWonA" | "gamesWonB">;

export type DropoutGamesMode = "count" | "void";

export interface BestNMemberInput {
  player: Player;
  status: "ACTIVE" | "DROPPED";
  isReplacement: boolean;
  scheduledGames: number;
}

export interface BestNDroppedResult {
  opponentId: string;
  opponent: string;
  points: number;
}

export interface BestNStandingRow extends StandingRow {
  counted: number;
  of: number;
  droppedResults: BestNDroppedResult[];
}

export interface BestNDivisionSummary {
  n: number;
  k: number;
  dropouts: number;
}

export interface BestNStandingsResult {
  rows: BestNStandingRow[];
  division: BestNDivisionSummary;
}

interface PlayerResult {
  opponentId: string;
  points: number;
  rank: 2 | 1 | 0;
  gamesWon: number;
  gamesLost: number;
}

function sortResultsBestFirst(results: PlayerResult[]): PlayerResult[] {
  return results
    .slice()
    .sort((x, y) => y.points - x.points || y.rank - x.rank || x.opponentId.localeCompare(y.opponentId));
}

export function computeBestNStandings(
  members: BestNMemberInput[],
  pairings: BestNPairing[],
  shootouts: ShootoutInput[] = [],
  scoring: ScoringConfig = DEFAULTS.scoring,
  dropoutGames: DropoutGamesMode = "count",
): BestNStandingsResult {
  const active = members.filter((m) => m.status === "ACTIVE");
  const droppedCount = members.filter((m) => m.status === "DROPPED").length;
  const replacementCount = active.filter((m) => m.isReplacement).length;
  const k = active.length + droppedCount;
  const dropouts = Math.max(0, droppedCount - replacementCount);
  const n = Math.max(0, k - 1 - dropouts);

  if (dropouts === 0) {
    const rows: BestNStandingRow[] = computeStandings(
      active.map((m) => m.player),
      pairings,
      shootouts,
      scoring,
    ).map((row) => ({ ...row, counted: row.played, of: row.played, droppedResults: [] }));
    return { rows, division: { n, k, dropouts } };
  }

  const droppedIds = new Set(members.filter((m) => m.status === "DROPPED").map((m) => m.player.id));
  const effectivePairings = dropoutGames === "void"
    ? pairings.filter((pr) => !droppedIds.has(pr.playerAId) && !droppedIds.has(pr.playerBId))
    : pairings;
  const effectiveShootouts = dropoutGames === "void"
    ? shootouts.filter((s) => !droppedIds.has(s.playerAId) && !droppedIds.has(s.playerBId))
    : shootouts;

  const playerById = new Map(members.map((m) => [m.player.id, m.player]));

  const resultsByPlayerId = new Map<string, PlayerResult[]>();
  for (const m of active) resultsByPlayerId.set(m.player.id, []);

  for (const pr of effectivePairings) {
    const aIsActive = resultsByPlayerId.has(pr.playerAId);
    const bIsActive = resultsByPlayerId.has(pr.playerBId);
    if (!aIsActive && !bIsActive) continue;
    const aPlayer = playerById.get(pr.playerAId);
    const bPlayer = playerById.get(pr.playerBId);
    if (!aPlayer || !bPlayer) continue;

    let aPoints = 0, bPoints = 0;
    let aRank: 2 | 1 | 0 = 0, bRank: 2 | 1 | 0 = 0;
    if (pr.gamesWonA === 2 && pr.gamesWonB === 0) {
      aPoints = scoring.pointsFor20Win; bPoints = scoring.pointsForLoss;
      aRank = 2; bRank = 0;
    } else if (pr.gamesWonA === 0 && pr.gamesWonB === 2) {
      bPoints = scoring.pointsFor20Win; aPoints = scoring.pointsForLoss;
      bRank = 2; aRank = 0;
    } else if (pr.gamesWonA === 1 && pr.gamesWonB === 1) {
      aPoints = scoring.pointsFor11Draw; bPoints = scoring.pointsFor11Draw;
      aRank = 1; bRank = 1;
    } else {
      continue;
    }

    if (aIsActive) {
      resultsByPlayerId.get(pr.playerAId)!.push({
        opponentId: pr.playerBId, points: aPoints, rank: aRank,
        gamesWon: pr.gamesWonA, gamesLost: pr.gamesWonB,
      });
    }
    if (bIsActive) {
      resultsByPlayerId.get(pr.playerBId)!.push({
        opponentId: pr.playerAId, points: bPoints, rank: bRank,
        gamesWon: pr.gamesWonB, gamesLost: pr.gamesWonA,
      });
    }
  }

  const countedOpponentsByPlayerId = new Map<string, Set<string>>();
  const rows: BestNStandingRow[] = [];

  for (const m of active) {
    const results = sortResultsBestFirst(resultsByPlayerId.get(m.player.id) ?? []);
    const of = m.isReplacement ? Math.min(n, m.scheduledGames) : n;
    const counted = Math.min(of, results.length);
    const countedResults = results.slice(0, counted);
    const droppedResults = results.slice(counted);

    countedOpponentsByPlayerId.set(m.player.id, new Set(countedResults.map((r) => r.opponentId)));

    let points = 0, wins = 0, draws = 0, losses = 0, gamesWon = 0, gamesLost = 0;
    for (const r of countedResults) {
      points += r.points; gamesWon += r.gamesWon; gamesLost += r.gamesLost;
      if (r.rank === 2) wins++;
      else if (r.rank === 1) draws++;
      else losses++;
    }

    rows.push({
      player: m.player,
      points, wins, draws, losses, gamesWon, gamesLost,
      played: results.length,
      counted, of,
      droppedResults: droppedResults.map((r) => ({
        opponentId: r.opponentId,
        opponent: playerById.get(r.opponentId)?.displayName ?? r.opponentId,
        points: r.points,
      })),
    });
  }

  const bothCounted = (xId: string, yId: string): boolean =>
    (countedOpponentsByPlayerId.get(xId)?.has(yId) ?? false) &&
    (countedOpponentsByPlayerId.get(yId)?.has(xId) ?? false);

  const sorted = rows.slice().sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (bothCounted(x.player.id, y.player.id)) {
      const h2h = headToHead(x.player.id, y.player.id, effectivePairings);
      if (h2h !== 0) return h2h;
    }
    const shoot = shootoutBetween(x.player.id, y.player.id, effectiveShootouts);
    if (shoot !== 0) return shoot;
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.draws !== x.draws) return y.draws - x.draws;
    return x.player.displayName.localeCompare(y.player.displayName);
  });

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const h2h = bothCounted(prev.player.id, cur.player.id)
      ? headToHead(prev.player.id, cur.player.id, effectivePairings)
      : 0;
    if (
      prev.points === cur.points &&
      h2h === 0 &&
      shootoutBetween(prev.player.id, cur.player.id, effectiveShootouts) === 0 &&
      prev.wins === cur.wins &&
      prev.draws === cur.draws
    ) {
      cur.tiedWithPrev = true;
    }
  }

  assignRanks(sorted);
  return { rows: sorted, division: { n, k, dropouts } };
}

export interface RawMemberForBestN {
  player: Player;
  status: "ACTIVE" | "DROPPED";
  joinedAt: Date;
  droppedAt: Date | null;
}

// Builds BestNMemberInput[] from raw DivisionMember-shaped rows + each
// member's total scheduled LEAGUE_BO2 game count. Centralizes the
// "isReplacement" heuristic (joined after another member's earliest real
// drop) so every caller -- the web's admin preview, and both the web's and
// the bot's live standings cache -- agrees on who's a replacement. Pure: no
// DB, no Prisma query, just data in. Mirrors the inline heuristic that used
// to live only in web/lib/loaders/standings-preview.ts.
export function buildBestNMembers(
  members: RawMemberForBestN[],
  scheduledGamesByPlayerId: ReadonlyMap<string, number>,
): BestNMemberInput[] {
  const earliestDropAt = members.reduce<Date | null>((min, m) => {
    if (m.status !== "DROPPED" || !m.droppedAt) return min;
    return !min || m.droppedAt < min ? m.droppedAt : min;
  }, null);
  return members.map((m) => ({
    player: m.player,
    status: m.status,
    isReplacement: m.status === "ACTIVE" && earliestDropAt !== null && m.joinedAt > earliestDropAt,
    scheduledGames: scheduledGamesByPlayerId.get(m.player.id) ?? 0,
  }));
}
