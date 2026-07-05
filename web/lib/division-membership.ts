// Shared helper: place a player into a division, ensuring they're not
// also in any other division in the same season. Existing-elsewhere
// memberships are deleted (transfer semantics) — a player has at most
// one DivisionMember per season at any time.
//
// All add-to-division code paths should go through this. There's a
// DB unique constraint (seasonId, playerId) that hard-enforces the rule;
// this function is what makes the user-facing semantics 'transfer' rather
// than 'error'.
//
// Also handles Discord role bookkeeping — strips the previous division's
// role from the player when a transfer happens, so they only carry the
// role of their current division.

import { prisma } from "@/lib/prisma";
import { isPlayerIdBanned } from "@/lib/bans";
import { addGuildMemberRole, removeGuildMemberRole } from "@/lib/discord";
import { resyncSeasonSchedules } from "@/lib/schedule-sync";
import { refreshStandingsCacheIfWarm } from "@/lib/standings-cache";
import { enqueueStandingsRefresh } from "@/lib/queue";

export interface PlaceResult {
  transferred: boolean;            // true if we removed an existing membership in another division
  previousDivisionName?: string;   // if transferred, the division they came from
  previousRoleRemoved?: boolean;   // true if we also stripped the previous division's Discord role
  roleAssigned?: boolean;          // true if we added the new division's Discord role (live add)
}

export async function placePlayerInDivision(
  divisionId: string,
  playerId: string,
): Promise<PlaceResult> {
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { id: true, seasonId: true, discordRoleId: true, season: { select: { leaguePlayerRoleId: true } } },
  });
  if (!division) throw new Error(`Division ${divisionId} not found`);

  // Ultimate backstop: a banned player must never end up in a division. Build /
  // placement paths filter banned players out earlier (so this won't fire during
  // a normal build); this catches any stray direct call (admin drag, replace).
  if (await isPlayerIdBanned(playerId)) {
    throw new Error("That player is banned from the league — unban them (/admin/bans) before placing them.");
  }
  const guildId = process.env.DISCORD_GUILD_ID;

  // Find any OTHER division in the same season the player already belongs to
  const existing = await prisma.divisionMember.findFirst({
    where: {
      playerId,
      division: { seasonId: division.seasonId },
      NOT: { divisionId: division.id },
    },
    include: {
      division: { select: { name: true, discordRoleId: true } },
      player: { select: { discordId: true } },
    },
  });

  let result: PlaceResult = { transferred: false };
  if (existing) {
    await prisma.divisionMember.delete({ where: { id: existing.id } });
    let previousRoleRemoved = false;
    if (guildId && existing.division.discordRoleId) {
      previousRoleRemoved = await removeGuildMemberRole(
        guildId,
        existing.player.discordId,
        existing.division.discordRoleId,
      );
    }
    result = {
      transferred: true,
      previousDivisionName: existing.division.name,
      previousRoleRemoved,
    };
  }

  // Place newly-added members at the END of the target division's
  // draftOrder sequence so the draft UI gets a deterministic position
  // (and so they don't collide with the default 0 on existing rows).
  // Only set draftOrder on CREATE — moving an existing member here
  // (via the late-add form re-adding a player) should keep their
  // current position, since this code path isn't the positional drag.
  const maxOrderRow = await prisma.divisionMember.findFirst({
    where: { divisionId: division.id },
    orderBy: { draftOrder: "desc" },
    select: { draftOrder: true },
  });
  const nextOrder = (maxOrderRow?.draftOrder ?? 0) + 1;

  // Snapshot Player.rating as seedRank — only on CREATE (initial
  // placement). Subsequent moves within the same season preserve the
  // original seed; we don't re-snapshot when admin transfers a player
  // mid-build. Null seedRank for players with no current Player.rating
  // (brand-new signups that haven't been ranked yet).
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { rating: true, discordId: true },
  });

  await prisma.divisionMember.upsert({
    where: { divisionId_playerId: { divisionId: division.id, playerId } },
    create: {
      divisionId: division.id,
      seasonId: division.seasonId,
      playerId,
      status: "ACTIVE",
      draftOrder: nextOrder,
      seedRank: player?.rating ?? null,
    },
    update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
  });

  // On a LIVE division (one with a Discord role/channel), give the player the
  // division role + the season's League Player role so they can actually see the
  // channel. Bootstrap does this at activation; mid-season adds need it here too.
  // No-op on a draft season (the division has no role yet).
  if (guildId && division.discordRoleId && player?.discordId) {
    result.roleAssigned = await addGuildMemberRole(guildId, player.discordId, division.discordRoleId);
    if (division.season.leaguePlayerRoleId) {
      await addGuildMemberRole(guildId, player.discordId, division.season.leaguePlayerRoleId);
    }
  }

  // Keep the pre-created schedule consistent: on a locked season this prunes any
  // matches the player orphaned by leaving their old division and assigns them
  // opponents in the new one. No-op on unlocked (draft / legacy) seasons.
  await resyncSeasonSchedules(division.seasonId);

  // Roster changed → refresh the standings cache for the new division (and the
  // one they left, if transferred) so the #league-standings post + web reflect
  // the new membership. Warm-only so a mid-build placement stays cheap; nudge
  // the channel if anything actually recomputed.
  const refreshedNew = await refreshStandingsCacheIfWarm(division.id).catch(() => false);
  const refreshedOld = existing ? await refreshStandingsCacheIfWarm(existing.divisionId).catch(() => false) : false;
  if (refreshedNew || refreshedOld) await enqueueStandingsRefresh().catch(() => {});

  return result;
}
