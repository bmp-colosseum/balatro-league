// Materialized standings cache. Anything that writes a Pairing should
// call recomputeDivisionStandings(divisionId) afterward to keep the
// cache fresh; render code calls loadDivisionStandings(divisionId)
// instead of computeStandings on raw rows so the standings query is
// effectively O(N) (one cache row + a Player join) instead of O(P^2).
//
// Cold reads (no cache row yet) compute fresh AND populate the cache
// as a side effect, so we never need a backfill migration — the cache
// warms naturally as divisions get rendered or new results land.

import { prisma } from "./db.js";
import { getLeagueSettingsForSeason } from "./league-settings.js";
import { projectDivisionMatches } from "./match-projection.js";
import { computeStandings, type StandingRow } from "./standings.js";

interface CachedRow {
  playerId: string;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  played: number;
  // Bot-side StandingRow doesn't carry tiedWithPrev (web's standings
  // helper has it; bot's doesn't). Field reserved for forward-compat
  // when/if we unify the two modules.
}

export async function recomputeDivisionStandings(divisionId: string): Promise<void> {
  // Transitional projection: keep the unified Match model current FIRST (it's
  // still derived from Pairing/Shootout until the writers cut over), THEN
  // compute standings from it. Best-effort — a projection failure must never
  // break the standings cache. Removed once writers populate Match directly.
  await projectDivisionMatches(divisionId).catch((err) =>
    console.warn(`[match-projection] division ${divisionId} failed:`, err),
  );
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
    // Cold cache: compute + populate, return the freshly computed rows.
    // Skips the inevitable double-read by computing locally first. Project
    // first so Match is current (transitional — see recompute).
    await projectDivisionMatches(divisionId).catch(() => {});
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
      }));
    await prisma.divisionStandings.create({
      data: { divisionId, rowsJson: JSON.stringify(payload) },
    }).catch(() => {
      // Race condition: another concurrent reader populated. Fine.
    });
    return rows;
  }
  // Warm cache: hydrate with Player rows (display name can change between
  // recomputes; we deliberately don't cache it).
  const payload = JSON.parse(cached.rowsJson) as CachedRow[];
  const players = payload.length === 0 ? [] : await prisma.player.findMany({
    where: { id: { in: payload.map((r) => r.playerId) } },
  });
  const playerById = new Map(players.map((p) => [p.id, p]));
  return payload
    .map((r) => {
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
      } satisfies StandingRow;
    })
    .filter((r): r is StandingRow => r !== null);
}
