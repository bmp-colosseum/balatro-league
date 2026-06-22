import "server-only";

// Find ACTIVE members of the active season who are no longer in the Discord
// server (so they can't actually play). One Discord API call per member, so this
// is run ON DEMAND from the admin players page (a "check server membership"
// button), never on every page load.

import { prisma } from "@/lib/prisma";
import { fetchGuildMember } from "@/lib/discord";

export interface ServerLeaver {
  playerId: string;
  displayName: string;
  discordId: string;
  divisionId: string;
  divisionName: string;
}

export async function loadServerLeavers(): Promise<ServerLeaver[]> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return [];

  const members = await prisma.divisionMember.findMany({
    where: { status: "ACTIVE", division: { season: { isActive: true } } },
    select: {
      divisionId: true,
      division: { select: { name: true } },
      player: { select: { id: true, discordId: true, displayName: true } },
    },
    orderBy: { division: { name: "asc" } },
  });

  const leavers: ServerLeaver[] = [];
  for (const m of members) {
    // Mock/seeded ids aren't real Discord accounts — skip the API call.
    if (!/^\d{17,20}$/.test(m.player.discordId)) continue;
    const inGuild = await fetchGuildMember(guildId, m.player.discordId);
    if (!inGuild) {
      leavers.push({
        playerId: m.player.id,
        displayName: m.player.displayName,
        discordId: m.player.discordId,
        divisionId: m.divisionId,
        divisionName: m.division.name,
      });
    }
  }
  return leavers;
}
