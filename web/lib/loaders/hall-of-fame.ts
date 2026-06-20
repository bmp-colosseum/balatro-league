import "server-only";

// Hall of Fame: the overall champion of every COMPLETED season — the winner of
// the top division — recomputed from the final standings, shown with their record
// and full match log. (Per-division winners could be added here later.)

import { prisma } from "@/lib/prisma";
import { computeStandings, assignRanks } from "@/lib/standings";
import { formatSeasonLabel } from "@/lib/format-season";

export interface HofMatch {
  opponentId: string;
  opponentName: string;
  myGames: number;
  oppGames: number;
  outcome: "win" | "loss" | "draw" | "void";
}
export interface HofChampion {
  playerId: string;
  playerName: string;
  discordId: string;
  divisionName: string;
  record: string;
  points: number;
}
export interface HofSeason {
  seasonId: string;
  seasonLabel: string;
  seasonNumber: number;
  endedAt: Date;
  champion: HofChampion | null;
  championMatches: HofMatch[];
}

export async function loadHallOfFame(): Promise<HofSeason[]> {
  const seasons = await prisma.season.findMany({
    where: { endedAt: { not: null }, archivedAt: null },
    orderBy: { number: "desc" },
    select: {
      id: true,
      number: true,
      subtitle: true,
      endedAt: true,
      tiers: {
        orderBy: { position: "asc" },
        select: {
          divisions: {
            orderBy: { groupNumber: "asc" },
            select: {
              id: true,
              name: true,
              members: { where: { status: "ACTIVE" }, select: { player: true } },
              matches: {
                where: { status: "CONFIRMED", format: { in: ["LEAGUE_BO2", "SHOOTOUT_BO1"] } },
                select: {
                  playerAId: true,
                  playerBId: true,
                  gamesWonA: true,
                  gamesWonB: true,
                  winnerId: true,
                  format: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const out: HofSeason[] = [];
  for (const s of seasons) {
    // The top of the league: first division in ladder order (tier position, then
    // group number). Its winner is the overall champion.
    const topDiv = s.tiers.flatMap((t) => t.divisions)[0];
    let champion: HofChampion | null = null;
    let championMatches: HofMatch[] = [];

    const players = topDiv?.members.map((m) => m.player) ?? [];
    if (topDiv && players.length > 0) {
      const bo2 = topDiv.matches.filter((m) => m.format === "LEAGUE_BO2");
      const shootouts = topDiv.matches
        .filter((m) => m.format === "SHOOTOUT_BO1" && m.winnerId)
        .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! }));
      const top = assignRanks(computeStandings(players, bo2, shootouts))[0];
      if (top) {
        champion = {
          playerId: top.player.id,
          playerName: top.player.displayName,
          discordId: top.player.discordId,
          divisionName: topDiv.name,
          record: `${top.wins}-${top.losses}-${top.draws}`,
          points: top.points,
        };
        const nameById = new Map(players.map((p) => [p.id, p.displayName]));
        championMatches = bo2
          .filter((m) => m.playerAId === top.player.id || m.playerBId === top.player.id)
          .map((m) => {
            const meIsA = m.playerAId === top.player.id;
            const myGames = meIsA ? m.gamesWonA : m.gamesWonB;
            const oppGames = meIsA ? m.gamesWonB : m.gamesWonA;
            const opponentId = meIsA ? m.playerBId : m.playerAId;
            const outcome: HofMatch["outcome"] =
              myGames === 0 && oppGames === 0
                ? "void"
                : myGames > oppGames
                  ? "win"
                  : myGames < oppGames
                    ? "loss"
                    : "draw";
            return { opponentId, opponentName: nameById.get(opponentId) ?? "Unknown", myGames, oppGames, outcome };
          });
      }
    }

    out.push({
      seasonId: s.id,
      seasonLabel: formatSeasonLabel(s),
      seasonNumber: s.number,
      endedAt: s.endedAt!,
      champion,
      championMatches,
    });
  }
  return out;
}
