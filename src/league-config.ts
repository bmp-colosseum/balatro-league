// Tiny KV helpers for LeagueConfig. All values are strings; serialize
// JSON yourself if you need structure.

import { prisma } from "./db.js";

export const LeagueConfigKey = {
  ResultsWebhookUrl: "results_webhook_url",
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
