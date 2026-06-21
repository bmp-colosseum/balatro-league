import "server-only";

// Swap two players BETWEEN divisions, trading their schedules wholesale: each
// player moves into the other's division and inherits the other's exact
// matchups. Everyone else is untouched — their opponent "A" simply becomes "B"
// and vice versa, so the SoS-balanced graph is preserved with no regenerate or
// resync. This is the right tool for a like-for-like roster swap.
//
// Only valid BEFORE either player has results: repointing a played/reported
// match would hand that result to the wrong player, so we refuse if either side
// has any non-(0-0 PENDING) match.

import { prisma } from "@/lib/prisma";
import { addGuildMemberRole, removeGuildMemberRole } from "@/lib/discord";

export class SwapError extends Error {}

export interface SwapResult {
  seasonId: string;
  divisionAName: string;
  divisionBName: string;
  repointed: number;
}

export async function swapDivisionPlayers(playerAId: string, playerBId: string): Promise<SwapResult> {
  if (!playerAId || !playerBId) throw new SwapError("Pick two players to swap.");
  if (playerAId === playerBId) throw new SwapError("Pick two different players.");

  // Both must be ACTIVE members of a division in the (same) active season.
  const memberSelect = {
    id: true,
    divisionId: true,
    seasonId: true,
    draftOrder: true,
    division: { select: { name: true, discordRoleId: true } },
    player: { select: { discordId: true, displayName: true } },
  } as const;
  const [memA, memB] = await Promise.all([
    prisma.divisionMember.findFirst({
      where: { playerId: playerAId, status: "ACTIVE", division: { season: { isActive: true } } },
      select: memberSelect,
    }),
    prisma.divisionMember.findFirst({
      where: { playerId: playerBId, status: "ACTIVE", division: { season: { isActive: true } } },
      select: memberSelect,
    }),
  ]);
  if (!memA || !memB) {
    throw new SwapError("Both players must be active members of a division in the active season.");
  }
  if (memA.seasonId !== memB.seasonId) {
    throw new SwapError("Both players must be in the same season.");
  }
  if (memA.divisionId === memB.divisionId) {
    throw new SwapError("Those players are already in the same division — a swap moves players between two different divisions.");
  }

  // Each player's own matchups (in their own division).
  const matchSelect = { id: true, playerAId: true, playerBId: true, status: true, gamesWonA: true, gamesWonB: true } as const;
  const [aMatches, bMatches] = await Promise.all([
    prisma.match.findMany({
      where: { divisionId: memA.divisionId, format: "LEAGUE_BO2", OR: [{ playerAId: playerAId }, { playerBId: playerAId }] },
      select: matchSelect,
    }),
    prisma.match.findMany({
      where: { divisionId: memB.divisionId, format: "LEAGUE_BO2", OR: [{ playerAId: playerBId }, { playerBId: playerBId }] },
      select: matchSelect,
    }),
  ]);

  // Guard: refuse if either side has a played/reported match.
  const isTouched = (m: { status: string; gamesWonA: number; gamesWonB: number }) =>
    m.status !== "PENDING" || m.gamesWonA > 0 || m.gamesWonB > 0;
  if ([...aMatches, ...bMatches].some(isTouched)) {
    throw new SwapError("Can't swap — one of these players already has a reported or played match this season. Swaps only work before either player has results.");
  }

  // Repoint a match's `from` player to `to`, keeping the canonical a<b ordering.
  // Cross-division guarantees no unique-key collision (the incoming player has no
  // existing match in the destination division).
  const repoint = (m: { id: string; playerAId: string; playerBId: string }, from: string, to: string) => {
    const other = m.playerAId === from ? m.playerBId : m.playerAId;
    const [a, b] = to < other ? [to, other] : [other, to];
    return prisma.match.update({ where: { id: m.id }, data: { playerAId: a, playerBId: b } });
  };

  await prisma.$transaction([
    ...aMatches.map((m) => repoint(m, playerAId, playerBId)),
    ...bMatches.map((m) => repoint(m, playerBId, playerAId)),
    // Trade divisions (and slot each into the other's draft position).
    prisma.divisionMember.update({ where: { id: memA.id }, data: { divisionId: memB.divisionId, draftOrder: memB.draftOrder } }),
    prisma.divisionMember.update({ where: { id: memB.id }, data: { divisionId: memA.divisionId, draftOrder: memA.draftOrder } }),
  ]);

  // Swap the division Discord roles (best-effort; League Player role stays put
  // since both remain in the season). Outside the DB transaction.
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    const aDc = memA.player.discordId;
    const bDc = memB.player.discordId;
    const aRole = memA.division.discordRoleId;
    const bRole = memB.division.discordRoleId;
    if (aRole) await removeGuildMemberRole(guildId, aDc, aRole).catch(() => {});
    if (bRole) await removeGuildMemberRole(guildId, bDc, bRole).catch(() => {});
    if (bRole) await addGuildMemberRole(guildId, aDc, bRole).catch(() => {});
    if (aRole) await addGuildMemberRole(guildId, bDc, aRole).catch(() => {});
  }

  return {
    seasonId: memA.seasonId,
    divisionAName: memA.division.name,
    divisionBName: memB.division.name,
    repointed: aMatches.length + bMatches.length,
  };
}
