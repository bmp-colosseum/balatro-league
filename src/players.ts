import type { User } from "discord.js";
import { prisma } from "./db.js";

// Look up the Player row for a Discord user, creating one if it doesn't exist.
// Display name follows the user's current Discord username — kept fresh on every call.
export async function getOrCreatePlayer(user: User) {
  return prisma.player.upsert({
    where: { discordId: user.id },
    create: { discordId: user.id, displayName: user.username },
    update: { displayName: user.username },
  });
}
