import "server-only";

// Every player with a real Discord ID, for the admin "message a player" picker.
// Sorted by name; seeded/fake players (non-snowflake ids) are excluded since the
// bot can't DM them.

import { prisma } from "@/lib/prisma";

const SNOWFLAKE = /^\d{17,20}$/;

export async function loadMessageablePlayers(): Promise<{ id: string; label: string; discordId: string }[]> {
  const players = await prisma.player.findMany({
    select: { id: true, displayName: true, discordId: true },
    orderBy: { displayName: "asc" },
  });
  return players
    .filter((p) => SNOWFLAKE.test(p.discordId))
    .map((p) => ({ id: p.id, label: p.displayName, discordId: p.discordId }));
}
