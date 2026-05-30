// Helper: validate a Discord ID and fetch the user's display name.
// Tries guild member first (for server-specific nicks), falls back to
// global Discord user lookup (works for anyone with a valid ID, no
// guild membership required). Only errors if Discord has no record
// of the user at all.

import { resolveDisplayName } from "@/lib/discord";

export interface ResolvedDiscordUser {
  discordId: string;
  displayName: string;
}

export async function resolveDiscordIdToDisplayName(
  guildId: string,
  rawId: string,
): Promise<ResolvedDiscordUser | { error: string }> {
  const discordId = rawId.trim();
  if (!/^\d{17,20}$/.test(discordId)) {
    return { error: "Discord ID must be 17-20 digits." };
  }
  const name = await resolveDisplayName(guildId, discordId);
  if (!name) {
    return { error: "No Discord user with that ID — double-check it's right." };
  }
  return { discordId, displayName: name };
}
