// "Sticky quick-actions" message kept near the bottom of a channel: schedule /
// start-match / status / standings / help in every division channel, and a
// quick-roll button bar (random deck/stake/combo/bans) in #bot-commands.
// Deleted + reposted as conversation pushes it up -- but GENTLY: see
// shouldRepostSticky for the full gate list. The overriding product rule is
// "never interrupt an active conversation" -- better a little stale than
// annoying. Both stickies are just different StickyTarget payloads run
// through the SAME gated tick -- there is exactly one throttle/repost
// implementation, keyed by an opaque stickyId instead of a division id.
//
// State:
//   - The posted message id lives in LeagueConfig under a namespaced key
//     (sticky_actions_msg:<stickyId> -- <stickyId> is a divisionId for a
//     division sticky, or the constant BOT_COMMANDS_STICKY_ID for the
//     bot-commands one), same raw-key pattern as shootout.ts's noticeKey()
//     -- no schema change needed.
//   - Per-channel activity (last message time, new-message count since the
//     last repost) is tracked in an in-memory Map -- no DB write per message.
//     It resets on redeploy, which just means the throttle starts "ready"
//     again rather than mid-cooldown; never a correctness problem, since the
//     other gates (3 new messages + a 30s lull) still have to pass fresh.

import {
  ChannelType,
  type BaseMessageOptions,
  type Client,
  type Message,
  type TextChannel,
} from "discord.js";
import { activePublicSeason } from "./active-season.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { seasonTimelineLines, parseBufferDays } from "./season-timing.js";
import { playerActionRows } from "./division-controls.js";
import { randomControlsRow } from "./random-controls.js";
import { prisma } from "./db.js";
import { logDiscordError } from "./log-discord-error.js";

// ---- Tunables -----------------------------------------------------------

// Minimum time between reposts of one division's sticky, even when every
// other gate passes. Env-overridable so ops can retune without a redeploy;
// defaults to 10 minutes.
const envMinInterval = Number(process.env.STICKY_MIN_INTERVAL_MS);
export const STICKY_MIN_INTERVAL_MS =
  Number.isFinite(envMinInterval) && envMinInterval > 0 ? envMinInterval : 10 * 60 * 1000;
// Need at least this many new non-bot messages since the last repost before
// we'll even consider bumping it -- a quiet channel doesn't need the sticky
// nudged just because time passed.
export const STICKY_MIN_NEW_MESSAGES = 3;
// The "lull" gate: only repost once nobody's posted for at least this long,
// so we never drop a delete+repost into the middle of an active
// back-and-forth. This is the gentleness knob the product asked for.
export const STICKY_LULL_MS = 30 * 1000;
// How often the background tick walks divisions and reposts where allowed.
const STICKY_TICK_MS = 60 * 1000;

// stickyId is a divisionId for a division sticky, or BOT_COMMANDS_STICKY_ID
// for the bot-commands one -- opaque to everything below this point.
export const stickyConfigKey = (stickyId: string): string => `sticky_actions_msg:${stickyId}`;

// The bot-commands channel isn't a Division row, so it needs a stable id of
// its own to key off of. "bot-commands" is not a valid cuid, so it can never
// collide with a real divisionId.
export const BOT_COMMANDS_STICKY_ID = "bot-commands";

// ---- Pure decision core ---------------------------------------------------

// Per-channel snapshot the shell gathers before deciding whether to repost.
export interface StickyChannelState {
  // ms epoch of the last repost, or null if we haven't posted one this run.
  lastPostAt: number | null;
  // Non-bot messages seen in the channel since the last repost.
  newMessagesSincePost: number;
  // ms epoch of the most recent non-bot message, or null if none seen yet.
  lastMessageAt: number | null;
  // True once we've confirmed (against the channel's actual last message)
  // that the sticky is NOT already the newest message there.
  stickyIsNotLastMessage: boolean;
}

// The single throttle decision -- every gate must hold. Pure: no clock reads,
// no I/O; the shell supplies `now` and the already-gathered state, so this is
// unit-testable with plain literals.
export function shouldRepostSticky(state: StickyChannelState, now: number): boolean {
  if (state.lastPostAt !== null && now - state.lastPostAt < STICKY_MIN_INTERVAL_MS) return false;
  if (state.newMessagesSincePost < STICKY_MIN_NEW_MESSAGES) return false;
  // Nothing has happened at all since boot -- no signal to act on.
  if (state.lastMessageAt === null) return false;
  if (now - state.lastMessageAt < STICKY_LULL_MS) return false;
  if (!state.stickyIsNotLastMessage) return false;
  return true;
}

// ---- In-memory activity tracking (shell) ---------------------------------

interface ChannelActivity {
  lastMessageAt: number;
  newMessagesSincePost: number;
  lastPostAt: number | null;
}

// Keyed by Discord channel id.
const channelActivity = new Map<string, ChannelActivity>();
// Which channel ids currently carry a sticky (division channels + the
// bot-commands channel, if configured), refreshed every tick -- lets the
// MessageCreate listener do a plain Map lookup instead of a DB query per
// message. channelId -> stickyId.
const stickyChannelIds = new Map<string, string>();
// channelId -> the message id of the sticky we most recently posted there, so
// the activity counter can ignore the sticky's own post while still counting
// every other message (including the bot's).
const stickyMessageIds = new Map<string, string>();

function activityFor(channelId: string): ChannelActivity {
  const existing = channelActivity.get(channelId);
  if (existing) return existing;
  const created: ChannelActivity = { lastMessageAt: 0, newMessagesSincePost: 0, lastPostAt: null };
  channelActivity.set(channelId, created);
  return created;
}

// Called from the MessageCreate listener for every message in the guild.
// Fire-and-forget by construction (purely synchronous, never throws) --
// counts a message toward a sticky channel's throttle state (division OR
// bot-commands), skipping bot messages (including our own sticky repost) so
// they never reset the lull timer or inflate the "new messages" count.
export function recordStickyChannelMessage(message: Message): void {
  try {
    if (!stickyChannelIds.has(message.channelId)) return;
    // Count BOT messages too -- everything except the sticky itself. Skipping
    // all bot posts meant a channel whose traffic is mostly the bot (e.g.
    // #bot-commands: match notifications, results) buried the sticky without
    // ever incrementing the counter, so it never re-posted. The real "is it
    // buried" test is stickyIsNotLastMessage (checked against Discord); this
    // counter is only the anti-churn throttle.
    if (stickyMessageIds.get(message.channelId) === message.id) return;
    const activity = activityFor(message.channelId);
    activity.lastMessageAt = message.createdTimestamp;
    activity.newMessagesSincePost += 1;
  } catch (err) {
    console.warn("[sticky-actions] recordStickyChannelMessage failed:", err);
  }
}

// ---- Message content ------------------------------------------------------

// Compact -- no big header, just the row. allowedMentions cleared so a
// repost (or the initial post) never pings anyone.
export function buildStickyActionsMessage(timeline: string[] = []): BaseMessageOptions {
  return {
    content: [...timeline, "**Quick actions**"].join("\n"),
    components: playerActionRows(),
    allowedMentions: { parse: [] },
  };
}

// The bot-commands sticky: a short quick-roll button bar. Kept deliberately
// brief -- it reposts like the division sticky, so it must never read as
// spammy.
export function buildBotCommandsStickyMessage(): BaseMessageOptions {
  return {
    content: "🎲 **Quick rolls** -- need a deck, stake, or ban pool fast? Tap a button.",
    components: [randomControlsRow()],
    allowedMentions: { parse: [] },
  };
}

// ---- Posting / reposting shell -------------------------------------------

// One sticky to manage: an opaque id (config-key + activity bookkeeping
// scope), the channel it lives in, and how to build its payload. Division
// stickies and the bot-commands sticky are both just a StickyTarget run
// through the same tick -- no duplicated gating logic.
export interface StickyTarget {
  stickyId: string;
  channelId: string;
  buildPayload: () => BaseMessageOptions | Promise<BaseMessageOptions>;
}

async function postSticky(channel: TextChannel, target: StickyTarget): Promise<void> {
  const payload = await target.buildPayload();
  const sent = await channel.send(payload);
  await prisma.leagueConfig.upsert({
    where: { key: stickyConfigKey(target.stickyId) },
    create: { key: stickyConfigKey(target.stickyId), value: sent.id, updatedBy: "system" },
    update: { value: sent.id, updatedBy: "system" },
  });
  stickyMessageIds.set(channel.id, sent.id);
  const activity = activityFor(channel.id);
  activity.newMessagesSincePost = 0;
  activity.lastPostAt = Date.now();
}

async function deleteSticky(channel: TextChannel, messageId: string): Promise<void> {
  await channel.messages.delete(messageId).catch((err) => {
    // Already gone (someone deleted it, or it's stale from a prior boot) --
    // not worth failing the repost over.
    logDiscordError("sticky-actions.delete", err, { channelId: channel.id, messageId });
  });
}

// Refresh which channels are "division channels" for the active season, and
// return the list to walk this tick. Cheap: one query per tick (not per
// message).
async function activeDivisionChannels(): Promise<Array<{ id: string; channelId: string }>> {
  const season = await activePublicSeason();
  if (!season) return [];
  const divisions = await prisma.division.findMany({
    where: { seasonId: season.id, discordChannelId: { not: null } },
    select: { id: true, discordChannelId: true },
  });
  const result: Array<{ id: string; channelId: string }> = [];
  for (const d of divisions) {
    if (!d.discordChannelId) continue;
    result.push({ id: d.id, channelId: d.discordChannelId });
  }
  return result;
}

// Run the full gated decision + delete/repost for exactly ONE sticky target
// (division or bot-commands) -- the single implementation both callers share.
async function tickSticky(client: Client, target: StickyTarget): Promise<void> {
  try {
    const ch = await client.channels.fetch(target.channelId).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) return;
    const channel = ch as TextChannel;

    const key = stickyConfigKey(target.stickyId);
    const existing = await prisma.leagueConfig.findUnique({ where: { key } });
    const storedId = existing?.value ?? null;

    // Never posted (fresh division/channel, or the sticky was manually
    // removed from config) -- post immediately, no throttle. There's
    // nothing to interrupt by adding one message to a channel that has
    // none of ours yet.
    if (!storedId) {
      await postSticky(channel, target);
      return;
    }

    // Confirm against the channel's actual last message (not just our
    // in-memory counter) that the sticky isn't already the newest thing
    // there -- a real check, so a missed gateway event or a bot restart
    // can't wedge this gate open forever.
    const lastMsgCollection = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    const newestMessageId = lastMsgCollection?.first()?.id ?? null;
    const stickyIsNotLastMessage = newestMessageId !== null && newestMessageId !== storedId;

    const activity = activityFor(channel.id);
    const state: StickyChannelState = {
      lastPostAt: activity.lastPostAt,
      newMessagesSincePost: activity.newMessagesSincePost,
      lastMessageAt: activity.lastMessageAt || null,
      stickyIsNotLastMessage,
    };
    if (!shouldRepostSticky(state, Date.now())) return;

    await deleteSticky(channel, storedId);
    await postSticky(channel, target);
  } catch (err) {
    logDiscordError("sticky-actions.tickSticky", err, { channelId: target.channelId });
  }
}

// Explicit, on-demand refresh of the bot-commands sticky -- called from boot
// (via runStickyTick, below) and from /league refresh-messages. Reuses the
// exact same gated tickSticky, so an admin mashing refresh-messages can't spam
// a repost into the middle of a conversation either. No-ops cleanly when
// BotCommandsChannelId is unset.
export async function refreshBotCommandsSticky(client: Client): Promise<void> {
  const channelId = await getConfig(LeagueConfigKey.BotCommandsChannelId);
  if (!channelId) return;
  await tickSticky(client, {
    stickyId: BOT_COMMANDS_STICKY_ID,
    channelId,
    buildPayload: () => buildBotCommandsStickyMessage(),
  });
}

async function runStickyTick(client: Client): Promise<void> {
  try {
    const divisions = await activeDivisionChannels();
    const botCommandsChannelId = await getConfig(LeagueConfigKey.BotCommandsChannelId);

    // Rebuild the set of channels the MessageCreate listener should count
    // activity for -- divisions AND bot-commands, if configured.
    stickyChannelIds.clear();
    for (const d of divisions) stickyChannelIds.set(d.channelId, d.id);
    if (botCommandsChannelId) stickyChannelIds.set(botCommandsChannelId, BOT_COMMANDS_STICKY_ID);

    // Resolve the season timeline ONCE per tick (not per division) so every
    // division's sticky shows the same live deadline/countdown above the buttons.
    const season = await activePublicSeason();
    const timeline = seasonTimelineLines(
      season?.scheduledEndAt ?? null,
      parseBufferDays(await getConfig(LeagueConfigKey.TiebreakBufferDays)),
    );
    for (const division of divisions) {
      await tickSticky(client, {
        stickyId: division.id,
        channelId: division.channelId,
        buildPayload: () => buildStickyActionsMessage(timeline),
      });
    }
    if (botCommandsChannelId) {
      await tickSticky(client, {
        stickyId: BOT_COMMANDS_STICKY_ID,
        channelId: botCommandsChannelId,
        buildPayload: () => buildBotCommandsStickyMessage(),
      });
    }
  } catch (err) {
    console.warn("[sticky-actions] tick failed:", err);
  }
}

// Boot entry point -- mirrors startMatchSweep's pattern (run once
// immediately, then on a fixed interval). Never throws; every failure inside
// the tick is caught and logged so a bad division/channel can't stop the
// loop or crash the bot.
export function startStickyActions(client: Client): void {
  void runStickyTick(client);
  setInterval(() => {
    void runStickyTick(client);
  }, STICKY_TICK_MS);
}
