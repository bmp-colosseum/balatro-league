// Materialized standings cache. Anything that writes a Pairing should
// call recomputeDivisionStandings(divisionId) afterward to keep the
// cache fresh; render code calls loadDivisionStandings(divisionId)
// instead of computeStandings on raw rows so the standings query is
// effectively O(N) (one cache row + a Player join) instead of O(P^2).
//
// Cold reads (no cache row yet) compute fresh AND populate the cache
// as a side effect, so we never need a backfill migration — the cache
// warms naturally as divisions get rendered or new results land.
//
// Mode-aware since the season-scoring-mode switch (mirrors
// web/lib/standings-cache.ts): a season's scoringMode ("all" |
// "best-n-count" | "best-n-void", see standings-mode.ts) decides whether a
// division's rows come from computeStandings or computeBestNStandings.
// Both branches land in the same StandingRow[] shape, so every existing
// reader of loadDivisionStandings keeps working unchanged. The optional
// "counts best N of K-1" badge is cached alongside the rows and read
// separately via loadDivisionScoringBadge (call AFTER the rows read in the
// same request, so the cache is already warm).

import type { PairingStatus, Player } from "@prisma/client";
import { prisma } from "./db.js";
import { getLeagueSettingsForSeason } from "./league-settings.js";
import { assignRanks, computeStandings, type StandingRow, type ShootoutInput } from "./standings.js";
import { computeBestNStandings, buildBestNMembers, type BestNPairing } from "./standings-best-n.js";
import { normalizeScoringMode, selectStandingsEngine, buildScoringBadge, normalizeTiebreak, type ScoringBadge } from "./standings-mode.js";
import { attachLivesToTiedRows } from "./standings-lives.js";
import { buildUncounted, type UncountedEntry } from "./uncounted-core.js";

interface CachedRow {
  playerId: string;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  played: number;
  tiedWithPrev?: boolean;
  // Set only under a best-N scoring mode -- see StandingRow.counted/of in
  // standings.ts. Absent for a legacy payload or an "all"-mode division.
  counted?: number;
  of?: number;
  // Set under season.tiebreak "lives" (every row), or under the default
  // "chain" for a row that's part of a tie group (attachLivesToTiedRows,
  // informational only -- see standings-lives.ts). Absent for every other
  // chain-mode row, so a division with no ties stays byte-for-byte
  // identical to before this field existed. See StandingRow.netLives/
  // livesGamesMissing in standings.ts.
  netLives?: number;
  livesGamesMissing?: number;
}

// On-disk shape of DivisionStandings.rowsJson. Legacy rows written before
// the scoring-mode switch are a bare CachedRow[] (no badge) -- parsePayload
// below accepts both.
interface CachedPayload {
  rows: CachedRow[];
  badge?: ScoringBadge;
  // Which of this division's results are set aside under a best-N scoring
  // mode -- see uncounted-core.ts. Absent (or empty) when nothing is set
  // aside right now. The bot itself never reads this back out (its
  // live-standings post only needs each row's counted/of) -- written here
  // purely so the cache payload stays byte-identical no matter which side
  // (bot or web) last recomputed it.
  uncounted?: UncountedEntry[];
}

function parsePayload(rowsJson: string): CachedPayload {
  const parsed = JSON.parse(rowsJson) as CachedRow[] | CachedPayload;
  return Array.isArray(parsed) ? { rows: parsed } : parsed;
}

interface DivisionForStandings {
  seasonId: string;
  opponentsPerPlayer: number | null;
  season: { scoringMode: string; tiebreak: string };
  members: {
    playerId: string;
    status: string;
    joinedAt: Date;
    droppedAt: Date | null;
    player: Player;
  }[];
  matches: {
    format: string;
    status: string;
    playerAId: string;
    playerBId: string;
    gamesWonA: number;
    gamesWonB: number;
    winnerId: string | null;
    games: { winnerId: string | null; winnerLives: number | null }[];
  }[];
}

const LIVE_MATCH_STATUSES: PairingStatus[] = ["CONFIRMED", "PENDING", "DISPUTED"];

const DIVISION_FOR_STANDINGS_INCLUDE = {
  seasonId: true,
  opponentsPerPlayer: true,
  season: { select: { scoringMode: true, tiebreak: true } },
  members: { select: { playerId: true, status: true, joinedAt: true, droppedAt: true, player: true } },
  matches: {
    // Live matches only: CONFIRMED feeds the engines; PENDING/DISPUTED count toward each
    // player's schedule size for best-N (a CANCELLED match against a dropout does not --
    // the refill that replaces it does).
    where: { status: { in: LIVE_MATCH_STATUSES } },
    select: {
      format: true,
      status: true,
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
      winnerId: true,
      // Per-game lives, only read when season.tiebreak is "lives" -- see
      // ./standings.js's PairingGameLives.
      games: { select: { winnerId: true, winnerLives: true } },
    },
  },
} as const;

// The one place that decides, for a division already loaded with its full
// (ACTIVE + DROPPED) roster and season.scoringMode, which engine to run and
// what to cache. Shared by recomputeDivisionStandings and the cold-cache
// branch of loadDivisionStandings so they can never drift from each other.
async function computeLiveStandings(div: DivisionForStandings): Promise<CachedPayload> {
  const { scoring } = await getLeagueSettingsForSeason(div.seasonId);
  const mode = normalizeScoringMode(div.season.scoringMode);
  const selection = selectStandingsEngine(mode);
  const tiebreak = normalizeTiebreak(div.season.tiebreak);

  const leagueMatches = div.matches.filter((m) => m.format === "LEAGUE_BO2");
  const pairings: BestNPairing[] = leagueMatches.filter((m) => m.status === "CONFIRMED").map((m) => ({
    playerAId: m.playerAId,
    playerBId: m.playerBId,
    gamesWonA: m.gamesWonA,
    gamesWonB: m.gamesWonB,
    games: m.games,
  }));
  const shootouts: ShootoutInput[] = div.matches
    .filter((m) => m.format === "SHOOTOUT_BO1" && m.status === "CONFIRMED" && m.winnerId !== null)
    .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! }));

  let rows: StandingRow[];
  let badge: ScoringBadge | null = null;
  let uncounted: UncountedEntry[] = [];

  if (selection.engine === "standard") {
    const activeMembers = div.members.filter((m) => m.status === "ACTIVE");
    rows = computeStandings(activeMembers.map((m) => m.player), pairings, shootouts, scoring, tiebreak);
  } else {
    const scheduledGamesByPlayerId = new Map<string, number>();
    for (const m of leagueMatches) {
      scheduledGamesByPlayerId.set(m.playerAId, (scheduledGamesByPlayerId.get(m.playerAId) ?? 0) + 1);
      scheduledGamesByPlayerId.set(m.playerBId, (scheduledGamesByPlayerId.get(m.playerBId) ?? 0) + 1);
    }
    const bestNMembers = buildBestNMembers(
      div.members.map((m) => ({
        player: m.player,
        status: m.status === "DROPPED" ? "DROPPED" : "ACTIVE",
        joinedAt: m.joinedAt,
        droppedAt: m.droppedAt,
      })),
      scheduledGamesByPlayerId,
    );
    const result = computeBestNStandings(bestNMembers, pairings, shootouts, scoring, selection.dropoutGames, div.opponentsPerPlayer ?? null, tiebreak);
    rows = result.rows;
    badge = buildScoringBadge(mode, result.division.n, result.division.k, result.division.scheduled, result.division.dropouts);
    uncounted = buildUncounted(
      div.members.map((m) => ({ playerId: m.playerId, status: m.status === "DROPPED" ? "DROPPED" : "ACTIVE" })),
      result.rows.map((r) => ({ playerId: r.player.id, droppedResults: r.droppedResults })),
      pairings,
      selection.dropoutGames,
    );
  }

  // Chain mode never reorders by lives, but a TIED player's net life
  // differential is still shown as informational context -- see
  // attachLivesToTiedRows's header. Under "lives", every row already carries
  // netLives from the engine itself, so this is a no-op there (every row
  // either already has it set, or isn't in a tie group and this would just
  // recompute the same thing -- skip entirely to avoid the redundant work).
  if (tiebreak === "chain") {
    attachLivesToTiedRows(rows, pairings);
  }

  const payload: CachedPayload = {
    rows: rows.map((r) => ({
      playerId: r.player.id,
      points: r.points,
      wins: r.wins,
      draws: r.draws,
      losses: r.losses,
      gamesWon: r.gamesWon,
      gamesLost: r.gamesLost,
      played: r.played,
      tiedWithPrev: r.tiedWithPrev,
      counted: r.counted,
      of: r.of,
      netLives: r.netLives,
      livesGamesMissing: r.livesGamesMissing,
    })),
  };
  if (badge) payload.badge = badge;
  if (uncounted.length > 0) payload.uncounted = uncounted;
  return payload;
}

export async function recomputeDivisionStandings(divisionId: string): Promise<void> {
  const div = await prisma.division.findUnique({
    where: { id: divisionId },
    select: DIVISION_FOR_STANDINGS_INCLUDE,
  });
  if (!div) return;
  const payload = await computeLiveStandings(div);
  await prisma.divisionStandings.upsert({
    where: { divisionId },
    create: { divisionId, rowsJson: JSON.stringify(payload) },
    update: { rowsJson: JSON.stringify(payload), computedAt: new Date() },
  });
}

export async function loadDivisionStandings(divisionId: string): Promise<StandingRow[]> {
  const cached = await prisma.divisionStandings.findUnique({ where: { divisionId } });
  if (!cached) {
    // Cold cache: compute + populate, return the freshly computed rows.
    const div = await prisma.division.findUnique({
      where: { id: divisionId },
      select: DIVISION_FOR_STANDINGS_INCLUDE,
    });
    if (!div) return [];
    const payload = await computeLiveStandings(div);
    await prisma.divisionStandings.create({
      data: { divisionId, rowsJson: JSON.stringify(payload) },
    }).catch(() => {
      // Race condition: another concurrent reader populated. Fine.
    });
    const players = payload.rows.length === 0 ? [] : await prisma.player.findMany({
      where: { id: { in: payload.rows.map((r) => r.playerId) } },
    });
    return hydrateRows(payload.rows, new Map(players.map((p) => [p.id, p])));
  }
  // Warm cache: hydrate with Player rows (display name can change between
  // recomputes; we deliberately don't cache it).
  const payload = parsePayload(cached.rowsJson);
  const players = payload.rows.length === 0 ? [] : await prisma.player.findMany({
    where: { id: { in: payload.rows.map((r) => r.playerId) } },
  });
  const playerById = new Map(players.map((p) => [p.id, p]));
  return hydrateRows(payload.rows, playerById);
}

// Reads the "counts best N of K-1" badge cached alongside a division's rows.
// Returns null when the division is standard-mode, has zero unreplaced
// dropouts right now, or (rare) the cache hasn't been warmed yet -- callers
// that need it warm should call loadDivisionStandings / recompute first in
// the same request.
export async function loadDivisionScoringBadge(divisionId: string): Promise<ScoringBadge | null> {
  const cached = await prisma.divisionStandings.findUnique({
    where: { divisionId },
    select: { rowsJson: true },
  });
  if (!cached) return null;
  return parsePayload(cached.rowsJson).badge ?? null;
}

function hydrateRows(payload: CachedRow[], playerById: Map<string, Player>): StandingRow[] {
  const hydrated = payload
    .map((r): StandingRow | null => {
      const player = playerById.get(r.playerId);
      if (!player) return null;
      return {
        player,
        points: r.points,
        wins: r.wins,
        draws: r.draws,
        losses: r.losses,
        gamesWon: r.gamesWon,
        gamesLost: r.gamesLost,
        played: r.played,
        tiedWithPrev: r.tiedWithPrev,
        counted: r.counted,
        of: r.of,
        netLives: r.netLives,
        livesGamesMissing: r.livesGamesMissing,
      };
    })
    .filter((r): r is StandingRow => r !== null);
  // Cached payload preserves sort order + tiedWithPrev; derive shared ranks.
  return assignRanks(hydrated);
}
