// Loader for the public /players roster page. Excludes mock players
// (test data marker) and pulls each player's active-season membership
// for the badge column.

import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { isMockPlayer } from "@/lib/mock";

export interface PlayerPickerEntry {
  id: string;
  displayName: string;
  discordId: string;
  username: string | null;
}

// Every player, shaped for the "add existing player by name" search
// pickers used by the season detail / signup / build-season admin pages.
// Assumes the calling page already gated on requireAdmin().
export async function loadAllPlayersForPicker(): Promise<PlayerPickerEntry[]> {
  return prisma.player.findMany({
    select: { id: true, displayName: true, discordId: true, username: true },
    orderBy: { displayName: "asc" },
  });
}

// Resolve a Discord ID to its internal player id (or null if no such
// player). Used to map the signed-in viewer to their player row for
// per-row reporting controls.
export async function loadPlayerIdByDiscordId(discordId: string): Promise<string | null> {
  const player = await prisma.player.findUnique({
    where: { discordId },
    select: { id: true },
  });
  return player?.id ?? null;
}

export interface PlayersListEntry {
  id: string;
  displayName: string;
  discordId: string;
  username: string | null;
  membership: {
    division: {
      id: string;
      name: string;
      seasonId: string;
      tierPosition: number;
    };
    dropped: boolean;
  } | null;
}

async function computePlayersList(): Promise<PlayersListEntry[]> {
  const allPlayers = await prisma.player.findMany({
    select: {
      id: true,
      discordId: true,
      username: true,
      displayName: true,
      memberships: {
        where: { division: { season: { isActive: true } } },
        select: {
          status: true,
          division: {
            select: {
              id: true,
              name: true,
              seasonId: true,
              tier: { select: { position: true } },
            },
          },
        },
      },
    },
    orderBy: { displayName: "asc" },
  });
  return allPlayers
    .filter((p) => !isMockPlayer(p))
    .map((p) => {
      const m = p.memberships[0];
      return {
        id: p.id,
        displayName: p.displayName,
        discordId: p.discordId,
        username: p.username,
        membership: m
          ? {
              division: {
                id: m.division.id,
                name: m.division.name,
                seasonId: m.division.seasonId,
                tierPosition: m.division.tier.position,
              },
              dropped: m.status === "DROPPED",
            }
          : null,
      };
    });
}

// The /players roster changes only when rosters change (signup/build/drop) —
// cache the list so repeat visitors don't each re-query every player + their
// membership. Returns plain objects (no Maps), so it serializes cleanly.
export const loadPlayersList = unstable_cache(computePlayersList, ["players-list-v1"], {
  revalidate: 120,
  tags: ["players"],
});
