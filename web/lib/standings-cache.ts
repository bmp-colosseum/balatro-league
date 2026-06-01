// Web-side mirror of src/standings-cache.ts. Same logic; lives here so
// server actions and pages can recompute/load without a cross-process
// round trip. Same DB so writes from either side stay in sync.

import { prisma } from "@/lib/prisma";
import { computeStandings, type StandingRow } from "@/lib/standings";

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
      pairings: {
        where: { status: "CONFIRMED" },
        select: {
          playerAId: true,
          playerBId: true,
          gamesWonA: true,
          gamesWonB: true,
        },
      },
    },
  });
  if (!div) return;
  const rows = computeStandings(div.members.map((m) => m.player), div.pairings);
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
        pairings: {
          where: { status: "CONFIRMED" },
          select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
        },
      },
    });
    if (!div) return [];
    const rows = computeStandings(div.members.map((m) => m.player), div.pairings);
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
  return payload
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
}
