// Data for the central /admin/results surface: the active-season divisions, a
// player list for the search box, and — once a division is picked (directly or
// by resolving a searched player) — its members + existing matches.

import { prisma } from "@/lib/prisma";

export interface ResultsDivisionOption {
  id: string;
  name: string;
  tierName: string;
}
export interface ResultsMember {
  playerId: string;
  displayName: string;
  discordId: string;
  username: string | null;
}
export interface ResultsMatch {
  id: string;
  format: string;
  playerAId: string;
  playerBId: string;
  aName: string;
  bName: string;
  aDiscordId: string;
  bDiscordId: string;
  aUsername: string | null;
  bUsername: string | null;
  gamesWonA: number;
  gamesWonB: number;
  status: string;
  forfeit: boolean;
  winnerId: string | null;
}
export interface ResultsSelection {
  division: ResultsDivisionOption;
  members: ResultsMember[];
  matches: ResultsMatch[];
}
export interface ResultsPageData {
  hasActiveSeason: boolean;
  divisions: ResultsDivisionOption[];
  allPlayers: ResultsMember[];
  selection: ResultsSelection | null;
  resolvedFromPlayer: ResultsMember | null;
}

export async function loadResultsPage(opts: { divisionId?: string; playerId?: string }): Promise<ResultsPageData> {
  const allPlayers = (
    await prisma.player.findMany({ select: { id: true, displayName: true, discordId: true, username: true }, orderBy: { displayName: "asc" } })
  ).map((p) => ({ playerId: p.id, displayName: p.displayName, discordId: p.discordId, username: p.username }));

  const season = await prisma.season.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!season) {
    return { hasActiveSeason: false, divisions: [], allPlayers, selection: null, resolvedFromPlayer: null };
  }

  const divisionsRaw = await prisma.division.findMany({
    where: { seasonId: season.id },
    select: { id: true, name: true, tier: { select: { name: true, position: true } } },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
  });
  const divisions: ResultsDivisionOption[] = divisionsRaw.map((d) => ({ id: d.id, name: d.name, tierName: d.tier.name }));

  // Resolve a searched player to their active-season division.
  let divisionId = opts.divisionId;
  let resolvedFromPlayer: ResultsMember | null = null;
  if (!divisionId && opts.playerId) {
    const mem = await prisma.divisionMember.findFirst({
      where: { playerId: opts.playerId, status: "ACTIVE", division: { seasonId: season.id } },
      select: { divisionId: true, player: { select: { id: true, displayName: true, discordId: true, username: true } } },
    });
    if (mem) {
      divisionId = mem.divisionId;
      resolvedFromPlayer = { playerId: mem.player.id, displayName: mem.player.displayName, discordId: mem.player.discordId, username: mem.player.username };
    }
  }

  let selection: ResultsSelection | null = null;
  const division = divisionId ? divisions.find((d) => d.id === divisionId) : undefined;
  if (division) {
    const membersRaw = await prisma.divisionMember.findMany({
      where: { divisionId: division.id, status: "ACTIVE" },
      select: { playerId: true, player: { select: { displayName: true, discordId: true, username: true } } },
      orderBy: { player: { displayName: "asc" } },
    });
    const members: ResultsMember[] = membersRaw.map((m) => ({ playerId: m.playerId, displayName: m.player.displayName, discordId: m.player.discordId, username: m.player.username }));
    const nameById = new Map(members.map((m) => [m.playerId, m.displayName]));
    const discordById = new Map(membersRaw.map((m) => [m.playerId, m.player.discordId]));
    const usernameById = new Map(membersRaw.map((m) => [m.playerId, m.player.username]));

    const matchesRaw = await prisma.match.findMany({
      where: { divisionId: division.id },
      select: {
        id: true, format: true, playerAId: true, playerBId: true,
        gamesWonA: true, gamesWonB: true, status: true, forfeit: true, winnerId: true,
      },
      orderBy: { confirmedAt: "desc" },
    });
    const matches: ResultsMatch[] = matchesRaw.map((m) => ({
      id: m.id,
      format: m.format,
      playerAId: m.playerAId,
      playerBId: m.playerBId,
      aName: nameById.get(m.playerAId) ?? m.playerAId,
      bName: nameById.get(m.playerBId) ?? m.playerBId,
      aDiscordId: discordById.get(m.playerAId) ?? "",
      bDiscordId: discordById.get(m.playerBId) ?? "",
      aUsername: usernameById.get(m.playerAId) ?? null,
      bUsername: usernameById.get(m.playerBId) ?? null,
      gamesWonA: m.gamesWonA,
      gamesWonB: m.gamesWonB,
      status: String(m.status),
      forfeit: m.forfeit,
      winnerId: m.winnerId,
    }));
    selection = { division, members, matches };
  }

  return { hasActiveSeason: true, divisions, allPlayers, selection, resolvedFromPlayer };
}
