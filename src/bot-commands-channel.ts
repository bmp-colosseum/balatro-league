// Resolves the bot-commands channel id with admin-override precedence:
//   env.BOT_COMMANDS_CHANNEL_ID → LeagueConfig.BotCommandsChannelId → null
//
// ensureBotCommandsChannel runs once at bot startup and, if neither
// source has a value, creates a public #bot-commands channel in the
// guild and stores its id in LeagueConfig so it survives restarts.
// Admin can override later by setting the env var (which always wins).

import { env } from "./env.js";
import { resolveConfiguredCategory, createGuildTextChannel } from "./discord-helpers.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";

// The bot-commands channel value may be a comma- (or whitespace-) separated
// LIST of channel ids — admins can allow public player commands in several
// channels. We extract every Discord snowflake (17-20 digit run) from the raw
// value, which makes this tolerant of how admins actually paste ids:
//   "123, 456"        → ["123","456"]
//   "<#123> <#456>"   → ["123","456"]   (channel MENTIONS copied from Discord)
//   "#name, 456"      → ["456"]          (a channel NAME has no snowflake, dropped)
// Without this, a single pasted <#…> mention or stray '#' made the whole list
// fail to match interaction.channelId, so commands worked in NO channel.
function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.match(/\d{17,20}/g) ?? [];
}

// Single id — the FIRST configured bot-commands channel. Used by callers that
// need one channel to POST to (e.g. report embeds when not in a division
// channel). Tolerates a CSV value by taking the first entry.
export async function resolveBotCommandsChannelId(): Promise<string | null> {
  const raw = env.BOT_COMMANDS_CHANNEL_ID || (await getConfig(LeagueConfigKey.BotCommandsChannelId));
  return parseIdList(raw)[0] ?? null;
}

// Full allow-list of channels where public ("not ephemeral") player commands
// may run: every configured bot-commands channel (CSV) PLUS the admin channel
// so staff can run them in admin chat. Membership-checked by the scope gate.
//
// The env var and the LeagueConfig value are MERGED (not env-overrides-config):
// admins manage the multi-channel list in /admin/config, and a leftover single
// BOT_COMMANDS_CHANNEL_ID env var (e.g. a stale one from a previous server) must
// not silently suppress that list. Both are parsed as CSV; ids are de-duped.
export async function resolveBotCommandsChannelIds(): Promise<string[]> {
  const fromEnv = parseIdList(env.BOT_COMMANDS_CHANNEL_ID);
  const fromConfig = parseIdList(await getConfig(LeagueConfigKey.BotCommandsChannelId));
  const admin = parseIdList(await getConfig(LeagueConfigKey.AdminChannelId));
  return Array.from(new Set([...fromEnv, ...fromConfig, ...admin]));
}

export async function ensureBotCommandsChannel(): Promise<void> {
  if (env.BOT_COMMANDS_CHANNEL_ID) {
    // Admin pinned a specific channel — respect that, don't auto-create.
    return;
  }
  const existing = await getConfig(LeagueConfigKey.BotCommandsChannelId);
  if (existing) return;
  if (!env.DISCORD_GUILD_ID) {
    console.warn("[bot-commands] DISCORD_GUILD_ID not set; skipping auto-create");
    return;
  }
  // Nest under the same '🃏 Balatro League' style category as everything
  // else for tidiness. Fall back to top-level if category creation fails.
  const category = await resolveConfiguredCategory(env.DISCORD_GUILD_ID, LeagueConfigKey.LeagueCategoryId, "🃏 Balatro League");
  const channel = await createGuildTextChannel(env.DISCORD_GUILD_ID, "league-bot-commands", {
    parentId: category?.id,
    topic: "Use match flow commands here when you're not in a division channel.",
  });
  if (!channel) {
    console.warn("[bot-commands] auto-create failed; admin can set BOT_COMMANDS_CHANNEL_ID env var or run /league set-bot-commands-channel manually");
    return;
  }
  await setConfig(LeagueConfigKey.BotCommandsChannelId, channel.id, "bot-startup-auto-create");
  console.log(`[bot-commands] auto-created channel ${channel.id} and stored in LeagueConfig`);
}
