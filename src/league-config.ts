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
  // Parent channel for LEAGUE /start-match private threads. Kept separate from
  // division channels so staff (who have ManageThreads on division channels to
  // see group threads) do NOT auto-see every match — match threads stay private
  // to the two players; /helper pulls a moderator in on demand. Auto-created on
  // first /start-match under the '🎴 Matches' category.
  LeagueMatchesChannelId: "league_matches_channel_id",
  // Pinned message id in #league-matches carrying the "Start a match" button that
  // opens a per-clicker dropdown of their remaining scheduled opponents.
  LeagueMatchesMessageId: "league_matches_message_id",
  // #league-queue: players mark themselves "free to play" via a pinned message
  // (LeagueQueueMessageId) carrying the Join/Leave buttons + the live free list.
  // When two scheduled opponents are both queued, the normal match invite fires.
  LeagueQueueChannelId: "league_queue_channel_id",
  LeagueQueueMessageId: "league_queue_message_id",
  // Private channel for infra/DevOps alerts (queue stalls, rate-limit
  // floods, anything that needs a tech person not a game admin). Resolved
  // env.DEVOPS_CHANNEL_ID → LeagueConfig.DevopsChannelId → null (alerts
  // log-only). Bootstrap auto-creates if neither is set.
  DevopsChannelId: "devops_channel_id",

  // ── Community channels (portability) ─────────────────────────────────
  // Optional channel ids set per-server on /admin/config so the bot can run
  // in any server without auto-creating channels. Right-click a channel →
  // Copy Channel ID. Unset = the related feature is simply unavailable.
  //   SupportChannelId  — /support opens private ticket threads here.
  //   AdminChannelId    — league admin/staff chat (reference/links).
  //   FeedbackChannelId — feedback / forum channel (reference/links).
  //   GeneralChannelId  — league general chat (reference/links).
  SupportChannelId: "support_channel_id",
  AdminChannelId: "admin_channel_id",
  FeedbackChannelId: "feedback_channel_id",
  GeneralChannelId: "general_channel_id",
  // Human-facing results channel (manual backup). The BOT posts to
  // ResultsChannelId (#league-results-bot); this one is for people to post in
  // if the bot's auto-post ever has an issue.
  ResultsHumanChannelId: "results_human_channel_id",
  // Casual /challenge result feed. When a casual match completes, the bot posts
  // a scoreline embed here so there's a browsable log of challenge results
  // (people use /challenge outside league play too). Resolution mirrors league
  // results: webhook → channel id → falls back to the #challenges channel so it
  // works with zero config. Webhook avoids the bot's global rate-limit budget.
  ChallengeResultsWebhookUrl: "challenge_results_webhook_url",
  ChallengeResultsChannelId: "challenge_results_channel_id",

  // Sign-ups-only / soft-launch mode. Set to "true" to disable every slash
  // command except /help while keeping the sign-up flow live. Use when the bot
  // is freshly in a new server and you only want sign-ups running until the
  // season actually starts; flip back to "false" (or clear it) on launch.
  SignupsOnlyMode: "signups_only_mode",

  // Lightweight league: set to "true" to NOT auto-create per-division Discord
  // channels/roles when a season activates. Matches happen in #bot-commands,
  // results announce to the central results channel, standings live on the web.
  // Admin can still create channels later from the season page. Season-start
  // announcements + #league-info still post.
  DivisionChannelsDisabled: "division_channels_disabled",

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
  //   CustomComboPresetId   — allowed stakes for the in-match custom-combo
  //                           "agree on a specific deck/stake" picker, so
  //                           admins can offer exotic stakes (Planet/Spectral
  //                           /…) there without changing the /challenge pool.
  //                           Falls back to the casual preset when unset.
  // Bootstrap creates a single 'Stock' preset and points both keys at
  // it on first run. Admin can repoint either one on /admin/deck-bans.
  SeasonDefaultPresetId: "season_default_preset_id",
  CasualPresetId: "casual_preset_id",
  CustomComboPresetId: "custom_combo_preset_id",

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
  // Default season length in DAYS — how long players get to play once the
  // season starts. Used to derive the "play your games" window in the signup
  // post when the admin hasn't set an explicit season end date (window =
  // sign-ups close → +N days). Unset = 14 (two weeks).
  SeasonLengthDays: "season_length_days",
  // Default channel the season signup embed posts to (e.g. #league-signups).
  // The web Open-signups form pre-selects this; /league setup adopts a channel
  // pinned here. The actual posted channel is still stored per-round on
  // SignupRound.channelId — this is just the default + the adoption target.
  SignupsChannelId: "signups_channel_id",
  // Message id of the self-updating league-info message. We edit THIS
  // message on every refresh (regardless of whether it's currently
  // pinned) so a lost/removed pin can't make the worker post duplicates.
  LeagueInfoMessageId: "league_info_message_id",

  // Read-only #league-help channel + the bot's pinned command-list message id.
  // /league setup creates the channel and posts/edits the pinned message (the
  // player command list + "type /help anywhere"), so it's rebootstrappable.
  HelpChannelId: "help_channel_id",
  HelpMessageId: "help_message_id",

  // Channel where the bot maintains a self-updating live standings post for the
  // active season (one embed per division). Read-only for members; the bot
  // re-renders it on a periodic schedule. Unset = the standings feed is off.
  StandingsChannelId: "standings_channel_id",
  // JSON array of the bot's standings message id(s) — standings can span several
  // messages (10 division-embeds each), so we remember all of them and edit in
  // place, posting/deleting only when the division count changes.
  StandingsMessageIds: "standings_message_ids",

  // Public, read-only channel for automated deploy / bot status posts (e.g. the
  // CI pipeline announcing "deploying…" / "back up" so players know when a brief
  // restart is happening). Bot/webhook-only; @everyone can view but not post.
  StatusChannelId: "status_channel_id",

  // Discord category IDs the bot creates its channels under. Resolved
  // config-first (so an admin can point the bot at an existing category on
  // a server it didn't create) → find-or-create by name fallback. Bootstrap
  // and the per-channel auto-create helpers both honor these and write the
  // resolved id back here.
  //   LeagueCategoryId  — the main "🃏 Balatro League" category (info,
  //                       signups, results, announcements, bot-commands, …).
  //   MatchesCategoryId — the "🎴 Matches" category that holds #challenges.
  LeagueCategoryId: "league_category_id",
  MatchesCategoryId: "matches_category_id",
  // "true" = the match-sweep applies Elowen to confirmed matches automatically
  // (hands-off live MMR). Default unset/"false" so MMR stays preview-only — you
  // recompute manually on /admin/mmr until you flip this on to go live.
  LiveMmrEnabled: "live_mmr_enabled",

  // Staff-only #league-transcripts channel: when a match/dispute thread closes,
  // the bot posts a brief summary (who spoke + counts) and a link to the web
  // transcript here. Auto-created (staff-only, via RoleBinding tiers) on first
  // use; the id is stored back here.
  TranscriptsChannelId: "transcripts_channel_id",
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
