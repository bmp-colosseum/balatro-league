import "server-only";

// One reinstate path for both buttons that bring a dropped player back
// (the profile's "Reinstate" and the division page's "Reactivate"), so
// they can't drift on what reinstating actually does. Refuses banned
// players, sets the membership ACTIVE, resyncs the season schedule so the
// player gets matches again (the resync itself DMs anyone whose matchups
// change), gives back the division's Discord role that a plain drop
// removes (web/lib/drop-player.ts), and refreshes standings.

import { prisma } from "@/lib/prisma";
import { isPlayerIdBanned } from "@/lib/bans";
import { addGuildMemberRole } from "@/lib/discord";
import { resyncSeasonSchedules } from "@/lib/schedule-sync";
import { refreshStandingsCacheIfWarm } from "@/lib/standings-cache";
import { enqueueStandingsRefresh } from "@/lib/queue";

export type ReinstateResult =
  | { outcome: "banned" }
  | { outcome: "not-dropped" }
  | { outcome: "reinstated"; divisionId: string };

export async function reinstateDroppedPlayer(playerId: string, seasonId: string): Promise<ReinstateResult> {
  if (await isPlayerIdBanned(playerId)) return { outcome: "banned" };

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId }, status: "DROPPED" },
    select: {
      id: true,
      divisionId: true,
      division: { select: { discordRoleId: true } },
      player: { select: { discordId: true } },
    },
  });
  if (!membership) return { outcome: "not-dropped" };

  await prisma.divisionMember.update({
    where: { id: membership.id },
    data: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
  });

  // Their matches were deleted on drop -- give them a schedule again. The
  // resync itself DMs anyone whose matchups changed as a result.
  await resyncSeasonSchedules(seasonId);

  // Give back the division role a plain drop removes. The season League
  // Player role was never taken away, so there's nothing to restore there.
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId && membership.division.discordRoleId) {
    await addGuildMemberRole(guildId, membership.player.discordId, membership.division.discordRoleId).catch(() => {});
  }

  if (await refreshStandingsCacheIfWarm(membership.divisionId).catch(() => false)) {
    await enqueueStandingsRefresh().catch(() => {});
  }
  return { outcome: "reinstated", divisionId: membership.divisionId };
}
