import "server-only";

// Swap two players BETWEEN divisions, trading their schedules wholesale: each
// player moves into the other's division and inherits the other's exact
// matchups. Everyone else keeps their own schedule slot, but whoever played
// the departing side of it now faces the incoming player instead -- so the
// SoS-balanced graph is preserved with no regenerate or resync, but opponent
// identities do change for those players. Everyone affected (A, B, and every
// player whose opponent "A" became "B" or vice versa) gets the same "your
// opponents changed" DM a drop or regenerate sends. This is the right tool
// for a like-for-like roster swap.
//
// Only valid BEFORE either player has results: repointing a played/reported
// match would hand that result to the wrong player, so we refuse if either side
// has any non-(0-0 PENDING) match.

import { prisma } from "@/lib/prisma";
import { bannedPlayerIdSet } from "@/lib/bans";
import { addGuildMemberRole, removeGuildMemberRole } from "@/lib/discord";
import { refreshStandingsCacheIfWarm } from "@/lib/standings-cache";
import { enqueueStandingsRefresh } from "@/lib/queue";
import { captureDivisionPairings, notifyScheduleRegenerated } from "@/lib/schedule-regenerate";

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
  const swapBanned = await bannedPlayerIdSet([playerAId, playerBId]);
  if (swapBanned.size > 0) {
    throw new SwapError("One of those players is banned from the league — unban them (/admin/bans) or DQ them from the division instead of swapping.");
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

  // Snapshot both divisions' pairings before repointing so the "your
  // opponents changed" DM can diff against it afterward -- every prior
  // opponent of A (in division A) now faces B instead, and vice versa.
  const pairingsBeforeA = await captureDivisionPairings(memA.divisionId);
  const pairingsBeforeB = await captureDivisionPairings(memB.divisionId);

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

  // Tell everyone whose matchups changed in either division -- A and B
  // themselves (new division, new opponents) plus every player who kept
  // their division but now faces the other swapped-in player instead.
  await notifyScheduleRegenerated(memA.divisionId, memA.division.name, pairingsBeforeA, "changed").catch((err) =>
    console.warn("[swap] schedule-change notify failed for division A:", err),
  );
  await notifyScheduleRegenerated(memB.divisionId, memB.division.name, pairingsBeforeB, "changed").catch((err) =>
    console.warn("[swap] schedule-change notify failed for division B:", err),
  );

  // Both divisions' rosters changed → refresh their standings caches so the
  // #league-standings post + web reflect the swap (warm-only; nudge the channel).
  const ra = await refreshStandingsCacheIfWarm(memA.divisionId).catch(() => false);
  const rb = await refreshStandingsCacheIfWarm(memB.divisionId).catch(() => false);
  if (ra || rb) await enqueueStandingsRefresh().catch(() => {});

  return {
    seasonId: memA.seasonId,
    divisionAName: memA.division.name,
    divisionBName: memB.division.name,
    repointed: aMatches.length + bMatches.length,
  };
}
