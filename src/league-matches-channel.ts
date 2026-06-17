// Resolves the parent channel for LEAGUE /start-match private threads.
//
// Why a dedicated channel: division channels grant staff ManageThreads so they
// can oversee the per-sub-group GROUP threads. ManageThreads exposes EVERY
// private thread in a channel, so if league match threads lived there, staff
// would auto-see every match too. Putting match threads in their own channel
// (no staff ManageThreads) keeps them private to the two players — a moderator
// only joins when someone runs /helper, which adds them to that thread.
//
// Public channel, private threads: anyone can see #league-matches exists, but
// each match thread is visible only to its two players + the bot (+ whoever
// /helper adds). Mirrors how #challenges hosts casual /challenge threads.

import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { resolveConfiguredCategory, createGuildTextChannel } from "./discord-helpers.js";
import { env } from "./env.js";

export async function resolveLeagueMatchesChannelId(): Promise<string | null> {
  return getConfig(LeagueConfigKey.LeagueMatchesChannelId);
}

// Return the channel id, auto-creating it under the '🎴 Matches' category on
// first use. Returns null if it can't be created (no guild / API failure) — the
// caller then falls back to the channel the command was run in.
export async function ensureLeagueMatchesChannel(): Promise<string | null> {
  const existing = await getConfig(LeagueConfigKey.LeagueMatchesChannelId);
  if (existing) return existing;
  if (!env.DISCORD_GUILD_ID) {
    console.warn("[league-matches-channel] DISCORD_GUILD_ID not set; skipping auto-create");
    return null;
  }
  const category = await resolveConfiguredCategory(env.DISCORD_GUILD_ID, LeagueConfigKey.MatchesCategoryId, "🎴 Matches");
  const channel = await createGuildTextChannel(env.DISCORD_GUILD_ID, "league-matches", {
    parentId: category?.id,
    topic: "League /start-match games spawn private threads here. Need a mod? Run /helper in your match.",
  });
  if (!channel) {
    console.warn("[league-matches-channel] auto-create failed; match threads fall back to the current channel");
    return null;
  }
  await setConfig(LeagueConfigKey.LeagueMatchesChannelId, channel.id, "start-match-auto-create");
  console.log(`[league-matches-channel] auto-created channel ${channel.id} and stored in LeagueConfig`);
  return channel.id;
}
