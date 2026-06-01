// Resolves the casual-challenge parent channel id with admin-override
// precedence:
//   LeagueConfig.ChallengesChannelId → null (fall back to interaction's
//                                      channel = bot-commands typically)
//
// ensureChallengesChannel runs at bot startup and, if no value is stored,
// creates a '🎴 Matches' category + '#challenges' text channel under it.
// Casual /challenge matches spawn private threads under this channel, so
// they have a dedicated home separate from #bot-commands (where the
// invite gets posted) and separate from division channels (where league
// /start-match threads live).

import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { ensureGuildCategory, createGuildTextChannel } from "./discord-helpers.js";
import { env } from "./env.js";

export async function resolveChallengesChannelId(): Promise<string | null> {
  return getConfig(LeagueConfigKey.ChallengesChannelId);
}

export async function ensureChallengesChannel(): Promise<void> {
  const existing = await getConfig(LeagueConfigKey.ChallengesChannelId);
  if (existing) return;
  if (!env.DISCORD_GUILD_ID) {
    console.warn("[challenges-channel] DISCORD_GUILD_ID not set; skipping auto-create");
    return;
  }
  // Dedicated 🎴 Matches category. Public by default — anyone can see
  // the channel + browse the thread list (private-thread membership
  // still keeps the match contents to the two players + bot).
  const category = await ensureGuildCategory(env.DISCORD_GUILD_ID, "🎴 Matches");
  const channel = await createGuildTextChannel(env.DISCORD_GUILD_ID, "challenges", {
    parentId: category?.id,
    topic: "Casual /challenge matches spawn private threads here. Browse the thread list for active games.",
  });
  if (!channel) {
    console.warn("[challenges-channel] auto-create failed; /challenge threads will fall back to bot-commands");
    return;
  }
  await setConfig(LeagueConfigKey.ChallengesChannelId, channel.id, "bot-startup-auto-create");
  console.log(`[challenges-channel] auto-created channel ${channel.id} and stored in LeagueConfig`);
}
