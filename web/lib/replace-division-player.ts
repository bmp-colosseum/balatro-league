import "server-only";

// Replace a departed league member (someone who left the Discord server, so they
// can no longer play) with a new person who isn't in the league yet — handing
// the new player the departed's exact matchups so the SoS-balanced graph is
// preserved with no regenerate or resync.
//
// PRE-PLAY ONLY: refuses if the departed has any reported/played match. That
// enforces the "never mid-season" rule AND is why there's no record/standings
// question — nothing's been played, so the new player just takes the slot.
// Modeled on swapDivisionPlayers, but one side is brand new and the other is
// dropped rather than moved.

import { prisma } from "@/lib/prisma";
import { fetchGuildMember, addGuildMemberRole, removeGuildMemberRole } from "@/lib/discord";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { enqueueStandingsRefresh, enqueueWelcomeRefresh } from "@/lib/queue";

export class ReplaceError extends Error {}

export interface ReplaceResult {
  seasonId: string;
  divisionName: string;
  departedName: string;
  newName: string;
  repointed: number;
}

export async function replaceDivisionPlayer(departedPlayerId: string, newDiscordId: string): Promise<ReplaceResult> {
  if (!departedPlayerId) throw new ReplaceError("Pick the player to replace.");
  newDiscordId = newDiscordId.trim();
  if (!/^\d{17,20}$/.test(newDiscordId)) {
    throw new ReplaceError("Enter the replacement's Discord ID (17–20 digits).");
  }

  // The departed must be an ACTIVE member of a division in the active season.
  const departed = await prisma.divisionMember.findFirst({
    where: { playerId: departedPlayerId, status: "ACTIVE", division: { season: { isActive: true } } },
    select: {
      id: true,
      divisionId: true,
      seasonId: true,
      draftOrder: true,
      seedRank: true,
      division: {
        select: { name: true, discordRoleId: true, season: { select: { leaguePlayerRoleId: true } } },
      },
      player: { select: { discordId: true, displayName: true } },
    },
  });
  if (!departed) throw new ReplaceError("That player isn't an active member of the current season.");
  if (departed.player.discordId === newDiscordId) throw new ReplaceError("That's the same person.");

  // The replacement can't already be in this season.
  const alreadyIn = await prisma.divisionMember.findFirst({
    where: { player: { discordId: newDiscordId }, seasonId: departed.seasonId },
    select: { id: true },
  });
  if (alreadyIn) throw new ReplaceError("That replacement is already in this season.");

  // The replacement must actually be in the Discord server (the whole point is
  // swapping in someone who can play). fetchGuildMember → null means they're not.
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new ReplaceError("No Discord server configured.");
  const member = await fetchGuildMember(guildId, newDiscordId);
  if (!member) {
    throw new ReplaceError("That person isn't in the Discord server — pick someone who's actually in the server.");
  }
  const newName = member.user?.global_name || member.nick || member.user?.username || "Player";

  // Departed's matchups in their division. Refuse if any are played/reported.
  const matches = await prisma.match.findMany({
    where: {
      divisionId: departed.divisionId,
      format: "LEAGUE_BO2",
      OR: [{ playerAId: departedPlayerId }, { playerBId: departedPlayerId }],
    },
    select: { id: true, playerAId: true, playerBId: true, status: true, gamesWonA: true, gamesWonB: true },
  });
  const touched = matches.some((m) => m.status !== "PENDING" || m.gamesWonA > 0 || m.gamesWonB > 0);
  if (touched) {
    throw new ReplaceError(
      "Can't replace — this player already has a reported or played match. Replacements only work before they've played.",
    );
  }

  // Materialize the replacement's Player row (reuse an existing one if they were
  // ever a player before; just don't clobber their record).
  const newPlayer = await prisma.player.upsert({
    where: { discordId: newDiscordId },
    create: { discordId: newDiscordId, displayName: newName },
    update: {},
  });

  // Repoint each match from departed → new, keeping the canonical a<b ordering.
  // The new player has no existing match in this division, so no unique collision.
  const repoint = (m: { id: string; playerAId: string; playerBId: string }) => {
    const other = m.playerAId === departedPlayerId ? m.playerBId : m.playerAId;
    const [a, b] = newPlayer.id < other ? [newPlayer.id, other] : [other, newPlayer.id];
    return prisma.match.update({ where: { id: m.id }, data: { playerAId: a, playerBId: b } });
  };

  await prisma.$transaction([
    ...matches.map(repoint),
    // Drop the departed — their slot is now the replacement's.
    prisma.divisionMember.update({
      where: { id: departed.id },
      data: { status: "DROPPED", droppedAt: new Date(), dropoutReason: `Left the server — replaced by ${newName}` },
    }),
    // Slot the replacement into the departed's exact spot (division + draft order).
    prisma.divisionMember.create({
      data: {
        divisionId: departed.divisionId,
        seasonId: departed.seasonId,
        playerId: newPlayer.id,
        status: "ACTIVE",
        draftOrder: departed.draftOrder,
        seedRank: departed.seedRank,
      },
    }),
  ]);

  // Discord roles: give the replacement the division + League Player roles so
  // they can see their channel. The departed already left, so stripping theirs
  // is moot — best-effort anyway. Outside the DB transaction.
  const divRole = departed.division.discordRoleId;
  const leagueRole = departed.division.season.leaguePlayerRoleId;
  if (divRole) await addGuildMemberRole(guildId, newDiscordId, divRole).catch(() => {});
  if (leagueRole) await addGuildMemberRole(guildId, newDiscordId, leagueRole).catch(() => {});
  if (divRole) await removeGuildMemberRole(guildId, departed.player.discordId, divRole).catch(() => {});

  await recomputeDivisionStandings(departed.divisionId).catch(() => {});
  await enqueueStandingsRefresh().catch(() => {});
  // Refresh the division welcome so the roster (and @division ping) reflects the
  // new player.
  await enqueueWelcomeRefresh(departed.seasonId).catch(() => {});

  return {
    seasonId: departed.seasonId,
    divisionName: departed.division.name,
    departedName: departed.player.displayName,
    newName,
    repointed: matches.length,
  };
}
