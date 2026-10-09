import "server-only";

// Hall of Fame: the overall champion of every COMPLETED season — the winner of
// the top division — recomputed from the final standings, shown with their record
// and full match log. Also every OTHER division's champion of that same season
// (divisionChampions below), for the v2 trophy shelf's "every division champion"
// view, which mirrors the "Nx <Tier> Winner" Discord roles.

import { prisma } from "@/lib/prisma";
import { computeStandings, assignRanks } from "@/lib/standings";
import type { StandingRow } from "@/lib/standings";
import { loadManyDivisionStandings } from "@/lib/standings-cache";
import { pickDivisionWinners } from "@/lib/loaders/admin-winners";
import { formatSeasonLabel } from "@/lib/format-season";
import { titleCounts } from "@/lib/hall-of-fame-core";
import { discordAvatarUrl } from "@/lib/avatar";

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
// One division's champion of an ended season -- every division, not just the
// top one (HofChampion/champion above stays the single league champion so v1
// keeps rendering unchanged). Ladder order (tierPosition asc, then division
// order within the tier) is the caller's responsibility, same as champion.
export interface HofDivisionChampion {
  playerId: string;
  playerName: string;
  discordId: string;
  divisionName: string;
  tierName: string;
  // Tier ladder position (1 = top, e.g. Legendary) -- same rarity-border /
  // "is this the Legendary title" use as HofChampion.tierPosition.
  tierPosition: number;
  points: number;
  record: string;
  // Career DIVISION title count: how many divisions (across every tier, every
  // ended season in this same Hall of Fame) this player has won -- the v2
  // trophy shelf's "xN" sticker. Distinct from HofChampion.titleCount, which
  // only counts LEAGUE (top-division) titles for the v1 view. Always >= 1.
  // Patched below, once every season's division champions are known.
  titleCount: number;
  // Discord avatar URL (web/lib/avatar.ts), null = no custom avatar (caller
  // falls back to initials/a placeholder). Patched below, same batched
  // lookup pattern as division.ts/standings.ts.
  avatarUrl: string | null;
}

export interface HofSeason {
  seasonId: string;
  seasonLabel: string;
  seasonNumber: number;
  endedAt: Date;
  champion: HofChampion | null;
  championMatches: HofMatch[];
  // Every division's champion this season, ladder order (tier position asc,
  // then group number asc) -- includes the league champion's own division as
  // its first entry. Divisions with no clear winner (unresolved tie at #1, or
  // no matches played) are skipped. Drives the v2 trophy shelf only.
  divisionChampions: HofDivisionChampion[];
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
          name: true,
          divisions: {
            orderBy: { groupNumber: "asc" },
            select: {
              id: true,
              name: true,
              championPlayerId: true,
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

  // Ladder (tier position asc, then group number asc) for every season, built
  // once so every division across every season can be read from the standings
  // cache in a SINGLE batched call below -- never recompute standings for the
  // per-division champions (only the league champion/match-log above still
  // recomputes, since it needs the raw match list for "road to the title").
  const seasonLadders = seasons.map((s) =>
    s.tiers.flatMap((t) => t.divisions.map((division) => ({ division, tierPosition: t.position, tierName: t.name }))),
  );
  const allDivisionIds = seasonLadders.flatMap((ladder) => ladder.map((e) => e.division.id));
  const standingsByDivision = await loadManyDivisionStandings(allDivisionIds);

  const out: HofSeason[] = [];
  for (let i = 0; i < seasons.length; i++) {
    const s = seasons[i]!;
    const ladder = seasonLadders[i]!;
    // The top of the league: first division in ladder order. Its winner is the
    // overall champion. Paired with its tier's position (not just the division)
    // so the champion record can carry the rarity this title was won at.
    const topEntry = ladder[0];
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

    // Every division's champion this season, off the cached standings (never
    // recomputed here) -- the admin-recorded championPlayerId wins when set,
    // else the unique rank-1 finisher. A division with no clear winner (a real
    // tie at #1, or nobody's played yet) contributes no entry.
    const divisionChampions: HofDivisionChampion[] = [];
    for (const entry of ladder) {
      const rows = standingsByDivision.get(entry.division.id) ?? [];
      const row = resolveDivisionChampionRow(entry.division.championPlayerId, rows);
      if (!row) continue;
      divisionChampions.push({
        playerId: row.player.id,
        playerName: row.player.displayName,
        discordId: row.player.discordId,
        divisionName: entry.division.name,
        tierName: entry.tierName,
        tierPosition: entry.tierPosition,
        points: row.points,
        record: `${row.wins}-${row.losses}-${row.draws}`,
        // Patched below, once every season's division champions are known.
        titleCount: 1,
        // Patched below, once avatars are batch-loaded.
        avatarUrl: null,
      });
    }

    out.push({
      seasonId: s.id,
      seasonLabel: formatSeasonLabel(s),
      seasonNumber: s.number,
      endedAt: s.endedAt!,
      champion,
      championMatches,
      divisionChampions,
    });
  }

  // Second pass: every season's champion is now known, so their career title
  // count (titleCounts, lib/hall-of-fame-core.ts) can be computed across the
  // whole Hall of Fame and patched onto each champion record. League titles
  // (v1, top division only) and division titles (v2 trophy shelf, every
  // division) are two independent tallies over the same generic function --
  // titleCounts only reads playerId, so each list just needs the right subjects.
  const champions = out.flatMap((s) => (s.champion ? [s.champion] : []));
  const counts = titleCounts(champions);
  for (const champion of champions) {
    champion.titleCount = counts.get(champion.playerId) ?? 1;
  }

  const allDivisionChampions = out.flatMap((s) => s.divisionChampions);
  const divisionCounts = titleCounts(allDivisionChampions);
  for (const dc of allDivisionChampions) {
    dc.titleCount = divisionCounts.get(dc.playerId) ?? 1;
  }

  // Discord avatars for every division champion -- ONE query by discordId,
  // same batched pattern as division.ts/standings.ts (never per-row).
  const championDiscordIds = allDivisionChampions.map((dc) => dc.discordId);
  const championAvatarGuildMembers = championDiscordIds.length === 0
    ? []
    : await prisma.guildMember.findMany({
        where: { discordId: { in: championDiscordIds } },
        select: { discordId: true, avatar: true },
      });
  const championAvatarHashByDiscordId = new Map(championAvatarGuildMembers.map((g) => [g.discordId, g.avatar]));
  for (const dc of allDivisionChampions) {
    dc.avatarUrl = discordAvatarUrl(dc.discordId, championAvatarHashByDiscordId.get(dc.discordId));
  }

  return out;
}

// Pure: the admin-recorded championPlayerId wins when set; otherwise the
// unique rank-1 finisher off already-ranked standings rows (assignRanks gives
// every genuinely-tied row the same rank, same convention as pickDivisionWinners,
// web/lib/loaders/admin-winners.ts). No clear winner (nobody's played, or a
// real tie at #1 with no admin override) returns null -- same rule as
// resolveDivisionChampionId in web/lib/loaders/role-audit.ts, duplicated here
// because that one only returns an id and this needs the row's own
// playerName/discordId/points/record too.
function resolveDivisionChampionRow(championPlayerId: string | null, rows: StandingRow[]): StandingRow | null {
  if (championPlayerId) return rows.find((r) => r.player.id === championPlayerId) ?? null;
  if (!rows.some((r) => r.played > 0)) return null;
  const winners = pickDivisionWinners(rows);
  return winners.length === 1 ? winners[0]! : null;
}
