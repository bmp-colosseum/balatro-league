// Web-side mirror of src/standings-cache.ts. Same logic; lives here so
// server actions and pages can recompute/load without a cross-process
// round trip. Same DB so writes from either side stay in sync.
//
// Mode-aware since the season-scoring-mode switch: a season's scoringMode
// ("all" | "best-n-count" | "best-n-void", see web/lib/standings-mode.ts)
// decides whether a division's rows come from computeStandings or
// computeBestNStandings. Both branches land in the SAME StandingRow[]
// shape, so every existing reader of loadDivisionStandings /
// loadManyDivisionStandings keeps working unchanged -- they just get
// correct numbers for whichever engine is active. The optional "counts
// best N of K-1" badge is cached alongside the rows and read separately via
// loadDivisionScoringBadge / loadManyDivisionScoringBadges (call AFTER the
// rows read in the same request, so the cache is already warm).

import type { Player } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getLeagueSettingsForSeason } from "@/lib/league-settings";
import { assignRanks, computeStandings, type StandingRow, type ShootoutInput } from "@/lib/standings";
import { computeBestNStandings, buildBestNMembers, type BestNPairing } from "@/lib/standings-best-n";
import { normalizeScoringMode, selectStandingsEngine, buildScoringBadge, type ScoringBadge } from "@/lib/standings-mode";

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
}

// On-disk shape of DivisionStandings.rowsJson. Legacy rows written before
// the scoring-mode switch are a bare CachedRow[] (no badge) -- parsePayload
// below accepts both.
interface CachedPayload {
  rows: CachedRow[];
  badge?: ScoringBadge;
}

function parsePayload(rowsJson: string): CachedPayload {
  const parsed = JSON.parse(rowsJson) as CachedRow[] | CachedPayload;
  return Array.isArray(parsed) ? { rows: parsed } : parsed;
}

interface DivisionForStandings {
  seasonId: string;
  opponentsPerPlayer: number | null;
  season: { scoringMode: string };
  members: {
    playerId: string;
    status: string;
    joinedAt: Date;
    droppedAt: Date | null;
    player: Player;
  }[];
  matches: {
    format: string;
    playerAId: string;
    playerBId: string;
    gamesWonA: number;
    gamesWonB: number;
    winnerId: string | null;
  }[];
}

const DIVISION_FOR_STANDINGS_INCLUDE = {
  seasonId: true,
  opponentsPerPlayer: true,
  season: { select: { scoringMode: true } },
  members: { select: { playerId: true, status: true, joinedAt: true, droppedAt: true, player: true } },
  matches: {
    where: { status: "CONFIRMED" },
    select: {
      format: true,
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
      winnerId: true,
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

  const leagueMatches = div.matches.filter((m) => m.format === "LEAGUE_BO2");
  const pairings: BestNPairing[] = leagueMatches.map((m) => ({
    playerAId: m.playerAId,
    playerBId: m.playerBId,
    gamesWonA: m.gamesWonA,
    gamesWonB: m.gamesWonB,
  }));
  const shootouts: ShootoutInput[] = div.matches
    .filter((m) => m.format === "SHOOTOUT_BO1" && m.winnerId !== null)
    .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! }));

  let rows: StandingRow[];
  let badge: ScoringBadge | null = null;

  if (selection.engine === "standard") {
    const activeMembers = div.members.filter((m) => m.status === "ACTIVE");
    rows = computeStandings(activeMembers.map((m) => m.player), pairings, shootouts, scoring);
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
    const result = computeBestNStandings(bestNMembers, pairings, shootouts, scoring, selection.dropoutGames, div.opponentsPerPlayer ?? null);
    rows = result.rows;
    badge = buildScoringBadge(mode, result.division.n, result.division.k, result.division.scheduled, result.division.dropouts);
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
    })),
  };
  if (badge) payload.badge = badge;
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

// Recompute a division's standings ONLY if it already has a warmed cache row.
// Roster-change paths (move / add / swap / drop) call this so the #league-
// standings post + web stay correct, while a mid-build placement (cache not yet
// warmed) stays cheap and skips. Returns true if it recomputed.
export async function refreshStandingsCacheIfWarm(divisionId: string): Promise<boolean> {
  const has = await prisma.divisionStandings.findUnique({
    where: { divisionId },
    select: { divisionId: true },
  });
  if (!has) return false;
  await recomputeDivisionStandings(divisionId);
  return true;
}

export async function loadDivisionStandings(divisionId: string): Promise<StandingRow[]> {
  const cached = await prisma.divisionStandings.findUnique({ where: { divisionId } });
  if (!cached) {
    const div = await prisma.division.findUnique({
      where: { id: divisionId },
      select: DIVISION_FOR_STANDINGS_INCLUDE,
    });
    if (!div) return [];
    const payload = await computeLiveStandings(div);
    await prisma.divisionStandings.create({
      data: { divisionId, rowsJson: JSON.stringify(payload) },
    }).catch(() => {});
    const players = await prisma.player.findMany({
      where: { id: { in: payload.rows.map((r) => r.playerId) } },
    });
    return hydrateRows(payload.rows, new Map(players.map((p) => [p.id, p])));
  }
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
// the same request, which this does NOT do on its own (no point paying a
// second compute just for the badge when the rows read already warms it).
export async function loadDivisionScoringBadge(divisionId: string): Promise<ScoringBadge | null> {
  const cached = await prisma.divisionStandings.findUnique({
    where: { divisionId },
    select: { rowsJson: true },
  });
  if (!cached) return null;
  return parsePayload(cached.rowsJson).badge ?? null;
}

export async function loadManyDivisionScoringBadges(
  divisionIds: string[],
): Promise<Map<string, ScoringBadge>> {
  const out = new Map<string, ScoringBadge>();
  if (divisionIds.length === 0) return out;
  const cached = await prisma.divisionStandings.findMany({
    where: { divisionId: { in: divisionIds } },
    select: { divisionId: true, rowsJson: true },
  });
  for (const c of cached) {
    const badge = parsePayload(c.rowsJson).badge;
    if (badge) out.set(c.divisionId, badge);
  }
  return out;
}

// Turn a cached payload + a player lookup into StandingRows. Pure — no DB.
function hydrateRows(payload: CachedRow[], playerById: Map<string, Player>): StandingRow[] {
  const rows = payload
    .map((r): StandingRow | null => {
      const player = playerById.get(r.playerId);
      if (!player) return null;
      const row: StandingRow = {
        player,
        points: r.points,
        wins: r.wins,
        draws: r.draws,
        losses: r.losses,
        gamesWon: r.gamesWon,
        gamesLost: r.gamesLost,
        played: r.played,
      };
      if (r.tiedWithPrev) row.tiedWithPrev = true;
      return row;
    })
    .filter((r): r is StandingRow => r !== null);
  // Cached payload preserves sort order + tiedWithPrev; derive shared ranks.
  return assignRanks(rows);
}

// Batched version of loadDivisionStandings for the /standings page, which
// needs every division at once. Collapses the per-division N+1 (one cache read
// + one player fetch each) into TWO queries total: one findMany for all cached
// payloads, one findMany for every referenced player. Cold-cache divisions
// (rare — recompute runs on every write) fall back to the single-division path.
export async function loadManyDivisionStandings(
  divisionIds: string[],
): Promise<Map<string, StandingRow[]>> {
  const out = new Map<string, StandingRow[]>();
  if (divisionIds.length === 0) return out;

  const cached = await prisma.divisionStandings.findMany({
    where: { divisionId: { in: divisionIds } },
    select: { divisionId: true, rowsJson: true },
  });

  const parsedByDiv = new Map<string, CachedRow[]>();
  const allPlayerIds = new Set<string>();
  for (const c of cached) {
    const payload = parsePayload(c.rowsJson);
    parsedByDiv.set(c.divisionId, payload.rows);
    for (const r of payload.rows) allPlayerIds.add(r.playerId);
  }

  const players = allPlayerIds.size === 0 ? [] : await prisma.player.findMany({
    where: { id: { in: [...allPlayerIds] } },
  });
  const playerById = new Map(players.map((p) => [p.id, p]));

  // Cold-cache divisions (no DivisionStandings row yet) each rebuild via
  // loadDivisionStandings, which recomputes AND warms the cache (writes the
  // row) so the next request is cheap. Run every cold rebuild concurrently
  // instead of inside a sequential `for await` loop — with N cold divisions
  // the old loop paid N sequential compute-and-write round trips; a locked
  // season landing on a fully cold cache (e.g. right after build-season)
  // could serialize dozens of these one after another. Warm divisions are
  // already-resolved data (no await), so Promise.all costs nothing extra
  // for them.
  const entries = await Promise.all(
    divisionIds.map(async (divisionId): Promise<readonly [string, StandingRow[]]> => {
      const payload = parsedByDiv.get(divisionId);
      const rows = payload ? hydrateRows(payload, playerById) : await loadDivisionStandings(divisionId);
      return [divisionId, rows] as const;
    }),
  );
  for (const [divisionId, rows] of entries) out.set(divisionId, rows);
  return out;
}
