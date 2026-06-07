// Resolves / auto-creates the support channel where /support opens ticket
// threads. Precedence: LeagueConfig.SupportChannelId → (auto-create on boot).
//
// ensureSupportChannel runs at bot startup and, if no value is stored, creates
// a public '#support' channel and stores its id in LeagueConfig. Players run
// /support anywhere; the bot spins up a PRIVATE ticket thread under this
// channel and pings the helper role(s). The channel itself stays public so
// the topic ("run /support") is discoverable; the ticket contents stay private
// to the requester + helpers via private-thread membership.

import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { createGuildTextChannel } from "./discord-helpers.js";
import { env } from "./env.js";

export async function ensureSupportChannel(): Promise<void> {
  const existing = await getConfig(LeagueConfigKey.SupportChannelId);
  if (existing) return;
  if (!env.DISCORD_GUILD_ID) {
    console.warn("[support-channel] DISCORD_GUILD_ID not set; skipping auto-create");
    return;
  }
  const channel = await createGuildTextChannel(env.DISCORD_GUILD_ID, "support", {
    topic: "Need help? Run /support to open a private ticket — a league helper will be pinged.",
  });
  if (!channel) {
    console.warn("[support-channel] auto-create failed; /support stays unavailable until a channel is configured");
    return;
  }
  await setConfig(LeagueConfigKey.SupportChannelId, channel.id, "bot-startup-auto-create");
  console.log(`[support-channel] auto-created channel ${channel.id} and stored in LeagueConfig`);
}
