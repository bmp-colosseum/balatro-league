// Shared profile/history loader. Returns a player's season-by-season trajectory.

import { Rarity, type Player } from "@prisma/client";
import { prisma } from "./db.js";
import { computeStandings } from "./standings.js";

export interface SeasonHistoryEntry {
  seasonId: string;
  seasonName: string;
  isActive: boolean;
  divisionName: string;
  rarity: Rarity;
  rank: number;          // 1-based; 0 if no pairings played
  totalMembers: number;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  played: number;
  status: "ACTIVE" | "DROPPED";
}

export interface PlayerHistory {
  player: Player;
  history: SeasonHistoryEntry[];
  totals: { seasons: number; wins: number; draws: number; losses: number; points: number; bestRank: number | null };
}

export async function loadPlayerHistory(playerId: string): Promise<PlayerHistory | null> {
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) return null;

  const memberships = await prisma.divisionMember.findMany({
    where: { playerId, division: { season: { visibility: "PUBLIC" } } },
    include: {
      division: {
        include: {
          season: true,
          members: { include: { player: true } },
          pairings: {
            where: { status: "CONFIRMED" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  const history: SeasonHistoryEntry[] = [];
  for (const m of memberships) {
    const rows = computeStandings(
      m.division.members.map((mm) => mm.player),
      m.division.pairings,
    );
    const myRow = rows.find((r) => r.player.id === playerId);
    const myRank = rows.findIndex((r) => r.player.id === playerId) + 1;
    history.push({
      seasonId: m.division.season.id,
      seasonName: m.division.season.name,
      isActive: m.division.season.isActive,
      divisionName: m.division.name,
      rarity: m.division.rarity,
      rank: myRow ? myRank : 0,
      totalMembers: rows.length,
      points: myRow?.points ?? 0,
      wins: myRow?.wins ?? 0,
      draws: myRow?.draws ?? 0,
      losses: myRow?.losses ?? 0,
      gamesWon: myRow?.gamesWon ?? 0,
      gamesLost: myRow?.gamesLost ?? 0,
      played: myRow?.played ?? 0,
      status: m.status,
    });
  }

  const totals = {
    seasons: history.length,
    wins: history.reduce((s, h) => s + h.wins, 0),
    draws: history.reduce((s, h) => s + h.draws, 0),
    losses: history.reduce((s, h) => s + h.losses, 0),
    points: history.reduce((s, h) => s + h.points, 0),
    bestRank: history.filter((h) => h.rank > 0).reduce<number | null>((best, h) => (best === null || h.rank < best ? h.rank : best), null),
  };

  return { player, history, totals };
}
