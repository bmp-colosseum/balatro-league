import "server-only";

// Hall of Fame: the overall champion of every COMPLETED season — the winner of
// the top division — recomputed from the final standings, shown with their record
// and full match log. (Per-division winners could be added here later.)

import { prisma } from "@/lib/prisma";
import { computeStandings, assignRanks } from "@/lib/standings";
import { formatSeasonLabel } from "@/lib/format-season";
import { titleCounts } from "@/lib/hall-of-fame-core";

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
  // Tier ladder position (1 = top, e.g. Legendary) of the division this title
  // was won in -- drives the v2 trophy shelf's rarity-coloured card border
  // and "is this a Legendary title" check. See lib/tier-colors.ts.
  tierPosition: number;
  // Career title count: how many of loadHallOfFame's OWN seasons this same
  // player has won (titleCounts, lib/hall-of-fame-core.ts) -- always >= 1
  // for a champion. Drives the v2 trophy shelf's "x2"/"x3" sticker.
  titleCount: number;
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
          position: true,
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
    // group number). Its winner is the overall champion. Paired with its tier's
    // position (not just the division) so the champion record can carry the
    // rarity this title was won at -- flatMap over divisions alone would lose
    // which tier each division came from.
    const topEntry = s.tiers.flatMap((t) => t.divisions.map((division) => ({ division, tierPosition: t.position })))[0];
    const topDiv = topEntry?.division;
    let champion: HofChampion | null = null;
    let championMatches: HofMatch[] = [];

    const players = topDiv?.members.map((m) => m.player) ?? [];
    if (topDiv && topEntry && players.length > 0) {
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
          tierPosition: topEntry.tierPosition,
          // Patched below, once every season's champion is known.
          titleCount: 1,
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

  // Second pass: every season's champion is now known, so their career title
  // count (titleCounts, lib/hall-of-fame-core.ts) can be computed across the
  // whole Hall of Fame and patched onto each champion record.
  const champions = out.flatMap((s) => (s.champion ? [s.champion] : []));
  const counts = titleCounts(champions);
  for (const champion of champions) {
    champion.titleCount = counts.get(champion.playerId) ?? 1;
  }

  return out;
}
