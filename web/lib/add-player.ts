// Helper: validate a Discord ID and fetch the user's guild display name.
// Returns null if not in the guild or the bot can't see them.

import { fetchGuildMember } from "@/lib/discord";

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
  const member = await fetchGuildMember(guildId, discordId);
  if (!member) {
    return { error: "User not found in this guild — make sure they've joined the server." };
  }
  const displayName = member.nick || member.user?.username || `Unknown (${discordId})`;
  return { discordId, displayName };
}
