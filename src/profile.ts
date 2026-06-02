// Shared profile/history loader. Returns a player's season-by-season trajectory.

import { type Player } from "@prisma/client";
import { prisma } from "./db.js";
import { computeStandings } from "./standings.js";
import { formatSeasonLabel } from "./format-season.js";

export interface MatchEntry {
  opponentPlayerId: string;
  opponentDisplayName: string;
  myGames: number;
  opponentGames: number;
  outcome: "WIN" | "DRAW" | "LOSS";
  confirmedAt: Date | null;
}

export interface SeasonHistoryEntry {
  seasonId: string;
  seasonName: string;
  isActive: boolean;
  divisionName: string;
  tierName: string;
  tierPosition: number;  // 1 = top
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
  matches: MatchEntry[];
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
          tier: true,
          members: { include: { player: true } },
          // Full pairings (for match list rendering); we still filter to CONFIRMED below
          pairings: {
            where: { status: "CONFIRMED" },
            include: { playerA: true, playerB: true },
            orderBy: { confirmedAt: "asc" },
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
      m.division.pairings.map((p) => ({
        playerAId: p.playerAId,
        playerBId: p.playerBId,
        gamesWonA: p.gamesWonA,
        gamesWonB: p.gamesWonB,
      })),
    );
    const myRow = rows.find((r) => r.player.id === playerId);
    const myRank = rows.findIndex((r) => r.player.id === playerId) + 1;

    // Per-set list for THIS player in THIS division
    const myMatches: MatchEntry[] = [];
    for (const p of m.division.pairings) {
      if (p.playerAId !== playerId && p.playerBId !== playerId) continue;
      const meIsA = p.playerAId === playerId;
      const opponent = meIsA ? p.playerB : p.playerA;
      const myGames = meIsA ? p.gamesWonA : p.gamesWonB;
      const oppGames = meIsA ? p.gamesWonB : p.gamesWonA;
      const outcome: MatchEntry["outcome"] =
        myGames > oppGames ? "WIN" : myGames < oppGames ? "LOSS" : "DRAW";
      myMatches.push({
        opponentPlayerId: opponent.id,
        opponentDisplayName: opponent.displayName,
        myGames,
        opponentGames: oppGames,
        outcome,
        confirmedAt: p.confirmedAt,
      });
    }

    history.push({
      seasonId: m.division.season.id,
      seasonName: formatSeasonLabel(m.division.season),
      isActive: m.division.season.isActive,
      divisionName: m.division.name,
      tierName: m.division.tier.name,
      tierPosition: m.division.tier.position,
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
      matches: myMatches,
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
