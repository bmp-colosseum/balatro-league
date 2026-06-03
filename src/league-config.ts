// Tiny KV helpers for LeagueConfig. All values are strings; serialize
// JSON yourself if you need structure.

import { prisma } from "./db.js";

export const LeagueConfigKey = {
  ResultsWebhookUrl: "results_webhook_url",
  // Channel where match results post (used when no webhook is set OR
  // when webhook delivery falls through). Resolved as
  // Season.resultsChannelId → LeagueConfig.ResultsChannelId →
  // env.RESULTS_CHANNEL_ID. Right-click channel in Discord → Copy
  // Channel ID. Bot must have Send Messages permission there.
  ResultsChannelId: "results_channel_id",
  // Channel where match-flow commands (/start-match, /challenge, /report)
  // are allowed in addition to division channels. Resolved as
  // env.BOT_COMMANDS_CHANNEL_ID → LeagueConfig.BotCommandsChannelId →
  // auto-created on bot startup if neither is set.
  BotCommandsChannelId: "bot_commands_channel_id",
  // Channel where daily league backup attachments are posted. Should be
  // staff-only since the JSON includes sensitive league config. Same
  // env → LeagueConfig → auto-create resolution as BotCommandsChannelId.
  BackupChannelId: "backup_channel_id",
  // Current BMP season tag, e.g. "season6". Auto-detected from
  // balatromp.com/leaderboards on bot startup + daily refresh; admin can
  // override by setting manually. Null/unset = only the no-season-param
  // current fetch is captured (we don't know what to label it with).
  BmpCurrentSeason: "bmp_current_season",
  // Whether to ALSO capture the previous BMP season on every refresh.
  // Default = unset/"false" — past seasons are frozen on BMP's side so
  // re-fetching them is wasted budget once the data's already on disk.
  // Set to "true" temporarily when you want to backfill the previous
  // season for everyone (e.g., right after season N launches and you
  // want every player to have a season N-1 row even if they joined
  // mid-season-N). Toggle off again when the backfill's done.
  BmpCapturePreviousSeason: "bmp_capture_previous_season",
  // Parent channel for casual /challenge threads. Lives under a dedicated
  // '🎴 Matches' category, separate from #bot-commands and division
  // channels. Optional — falls back to interaction.channel when unset,
  // which matches the original /challenge behavior.
  ChallengesChannelId: "challenges_channel_id",
  // Private channel for infra/DevOps alerts (queue stalls, rate-limit
  // floods, anything that needs a tech person not a game admin). Resolved
  // env.DEVOPS_CHANNEL_ID → LeagueConfig.DevopsChannelId → null (alerts
  // log-only). Bootstrap auto-creates if neither is set.
  DevopsChannelId: "devops_channel_id",

  // ── Tunable league rules (all integers, stored as strings) ───────────
  // Scoring: points awarded per match outcome. Defaults 3/1/0 mirror the
  // current Dunk-original rules. Admin can change mid-season if needed —
  // the standings cache picks up the new values on the next recompute.
  PointsFor20Win: "points_for_2_0_win",
  PointsFor11Draw: "points_for_1_1_draw",
  PointsForLoss: "points_for_loss",

  // Match ban/pick policy. The flow is fixed (first bans 1, second bans
  // SecondPlayerBans, first bans (FirstPlayerBans - 1), second picks
  // from remainder) but the totals are tunable. Constraint enforced at
  // read time: poolSize - FirstPlayerBans - SecondPlayerBans must be >= 1.
  FirstPlayerBans: "first_player_bans",
  SecondPlayerBans: "second_player_bans",
  MatchPoolSize: "match_pool_size",

  // Timeouts. MatchInviteExpiryMinutes covers /start-match and /challenge
  // invite acceptance windows. ReportAutoConfirmSeconds is the grace
  // period before a PENDING report auto-confirms in #results.
  MatchInviteExpiryMinutes: "match_invite_expiry_minutes",
  ReportAutoConfirmSeconds: "report_auto_confirm_seconds",

  // Hash of the slash-command shapes last registered with Discord. Used
  // by ensureCommandsRegistered() at bot boot to skip the register call
  // when nothing has changed — saves a Discord API round-trip + keeps us
  // well clear of the ~200/day global-command rate limit.
  LastCommandsHash: "last_commands_hash",

  // Pointers from semantic role → preset id. Preset names carry no
  // meaning; what matters is which preset these pointers reference.
  //   SeasonDefaultPresetId — fallback for /start-match when a season
  //                           hasn't picked a per-season preset.
  //   CasualPresetId        — used by /challenge.
  // Bootstrap creates a single 'Stock' preset and points both keys at
  // it on first run. Admin can repoint either one on /admin/deck-bans.
  SeasonDefaultPresetId: "season_default_preset_id",
  CasualPresetId: "casual_preset_id",

  // Public-facing Discord server invite URL (e.g. https://discord.gg/abc).
  // Shown on the website's /join page so prospective players can find
  // the server without first having to know someone in it. Admin sets
  // this once via /admin/config; not auto-generated since server-wide
  // invites have their own lifecycle (admin may want a never-expiring
  // vanity URL or a limited-uses promo invite, etc.).
  DiscordServerInviteUrl: "discord_server_invite_url",

  // Channel for league-wide announcements: scheduled season start
  // notifications, season-end recap, anything that goes to everyone
  // rather than a specific division. Same env → LeagueConfig →
  // auto-create resolution as BotCommandsChannelId. Public channel —
  // every server member can see and read but only the bot posts.
  AnnouncementsChannelId: "announcements_channel_id",

  // Channel where the bot maintains a self-updating pinned "league
  // info" message: static rules + intro on top, dynamic current-state
  // block below (signups open / season N live / season N ended).
  // Persisted from /league bootstrap-server; the refresh worker
  // re-edits the pinned message on signup/season events.
  LeagueInfoChannelId: "league_info_channel_id",
} as const;

export type LeagueConfigKey = (typeof LeagueConfigKey)[keyof typeof LeagueConfigKey];

export async function getConfig(key: LeagueConfigKey): Promise<string | null> {
  const row = await prisma.leagueConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setConfig(key: LeagueConfigKey, value: string, updatedBy: string): Promise<void> {
  await prisma.leagueConfig.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
}

export async function clearConfig(key: LeagueConfigKey): Promise<void> {
  await prisma.leagueConfig.deleteMany({ where: { key } });
}
