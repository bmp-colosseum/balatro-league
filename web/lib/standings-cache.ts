// Web-side mirror of src/standings-cache.ts. Same logic; lives here so
// server actions and pages can recompute/load without a cross-process
// round trip. Same DB so writes from either side stay in sync.

import type { Player } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getLeagueSettingsForSeason } from "@/lib/league-settings";
import { assignRanks, computeStandings, type StandingRow } from "@/lib/standings";

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

export async function recomputeDivisionStandings(divisionId: string): Promise<void> {
  const div = await prisma.division.findUnique({
    where: { id: divisionId },
    include: {
      members: { where: { status: "ACTIVE" }, include: { player: true } },
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
    },
  });
  if (!div) return;
  const { scoring } = await getLeagueSettingsForSeason(div.seasonId);
  const rows = computeStandings(
    div.members.map((m) => m.player),
    div.matches.filter((m) => m.format === "LEAGUE_BO2"),
    div.matches
      .filter((m) => m.format === "SHOOTOUT_BO1" && m.winnerId !== null)
      .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! })),
    scoring,
  );
  const payload: CachedRow[] = rows.map((r) => ({
    playerId: r.player.id,
    points: r.points,
    wins: r.wins,
    draws: r.draws,
    losses: r.losses,
    gamesWon: r.gamesWon,
    gamesLost: r.gamesLost,
    played: r.played,
    tiedWithPrev: r.tiedWithPrev,
  }));
  await prisma.divisionStandings.upsert({
    where: { divisionId },
    create: { divisionId, rowsJson: JSON.stringify(payload) },
    update: { rowsJson: JSON.stringify(payload), computedAt: new Date() },
  });
}

export async function loadDivisionStandings(divisionId: string): Promise<StandingRow[]> {
  const cached = await prisma.divisionStandings.findUnique({ where: { divisionId } });
  if (!cached) {
    const div = await prisma.division.findUnique({
      where: { id: divisionId },
      include: {
        members: { where: { status: "ACTIVE" }, include: { player: true } },
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
      },
    });
    if (!div) return [];
    const { scoring } = await getLeagueSettingsForSeason(div.seasonId);
    const rows = computeStandings(
      div.members.map((m) => m.player),
      div.matches.filter((m) => m.format === "LEAGUE_BO2"),
      div.matches
        .filter((m) => m.format === "SHOOTOUT_BO1" && m.winnerId !== null)
        .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! })),
      scoring,
    );
    const payload: CachedRow[] = rows.map((r) => ({
      playerId: r.player.id,
      points: r.points,
      wins: r.wins,
      draws: r.draws,
      losses: r.losses,
      gamesWon: r.gamesWon,
      gamesLost: r.gamesLost,
      played: r.played,
      tiedWithPrev: r.tiedWithPrev,
    }));
    await prisma.divisionStandings.create({
      data: { divisionId, rowsJson: JSON.stringify(payload) },
    }).catch(() => {});
    return rows;
  }
  const payload = JSON.parse(cached.rowsJson) as CachedRow[];
  const players = payload.length === 0 ? [] : await prisma.player.findMany({
    where: { id: { in: payload.map((r) => r.playerId) } },
  });
  const playerById = new Map(players.map((p) => [p.id, p]));
  return hydrateRows(payload, playerById);
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
    const payload = JSON.parse(c.rowsJson) as CachedRow[];
    parsedByDiv.set(c.divisionId, payload);
    for (const r of payload) allPlayerIds.add(r.playerId);
  }

  const players = allPlayerIds.size === 0 ? [] : await prisma.player.findMany({
    where: { id: { in: [...allPlayerIds] } },
  });
  const playerById = new Map(players.map((p) => [p.id, p]));

  for (const divisionId of divisionIds) {
    const payload = parsedByDiv.get(divisionId);
    out.set(divisionId, payload ? hydrateRows(payload, playerById) : await loadDivisionStandings(divisionId));
  }
  return out;
}
