// "Sticky quick-actions" message kept near the bottom of every division
// channel: schedule / start-match / status / standings / help, always one
// click away. Deleted + reposted as conversation pushes it up -- but GENTLY:
// see shouldRepostSticky for the full gate list. The overriding product rule
// is "never interrupt an active conversation" -- better a little stale than
// annoying.
//
// State:
//   - The posted message id lives in LeagueConfig under a namespaced key
//     (sticky_actions_msg:<divisionId>), same raw-key pattern as
//     shootout.ts's noticeKey() -- no schema change needed.
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
import { divisionControlsRow } from "./division-controls.js";
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

const stickyConfigKey = (divisionId: string): string => `sticky_actions_msg:${divisionId}`;

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
// Which channel ids are currently division channels, refreshed every tick
// from the active season -- lets the MessageCreate listener do a plain Map
// lookup instead of a DB query per message.
const divisionChannelIds = new Map<string, string>(); // channelId -> divisionId

function activityFor(channelId: string): ChannelActivity {
  const existing = channelActivity.get(channelId);
  if (existing) return existing;
  const created: ChannelActivity = { lastMessageAt: 0, newMessagesSincePost: 0, lastPostAt: null };
  channelActivity.set(channelId, created);
  return created;
}

// Called from the MessageCreate listener for every message in the guild.
// Fire-and-forget by construction (purely synchronous, never throws) --
// counts a message toward a division channel's throttle state, skipping bot
// messages (including our own sticky repost) so they never reset the lull
// timer or inflate the "new messages" count.
export function recordDivisionChannelMessage(message: Message): void {
  try {
    if (message.author.bot) return;
    const divisionId = divisionChannelIds.get(message.channelId);
    if (!divisionId) return;
    const activity = activityFor(message.channelId);
    activity.lastMessageAt = message.createdTimestamp;
    activity.newMessagesSincePost += 1;
  } catch (err) {
    console.warn("[sticky-actions] recordDivisionChannelMessage failed:", err);
  }
}

// ---- Message content ------------------------------------------------------

// Compact -- no big header, just the row. allowedMentions cleared so a
// repost (or the initial post) never pings anyone.
export function buildStickyActionsMessage(): BaseMessageOptions {
  return {
    content: "**Quick actions**",
    components: [divisionControlsRow()],
    allowedMentions: { parse: [] },
  };
}

// ---- Posting / reposting shell -------------------------------------------

async function postSticky(channel: TextChannel, divisionId: string): Promise<void> {
  const sent = await channel.send(buildStickyActionsMessage());
  await prisma.leagueConfig.upsert({
    where: { key: stickyConfigKey(divisionId) },
    create: { key: stickyConfigKey(divisionId), value: sent.id, updatedBy: "system" },
    update: { value: sent.id, updatedBy: "system" },
  });
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
async function refreshDivisionChannelIds(): Promise<Array<{ id: string; channelId: string }>> {
  const season = await activePublicSeason();
  divisionChannelIds.clear();
  if (!season) return [];
  const divisions = await prisma.division.findMany({
    where: { seasonId: season.id, discordChannelId: { not: null } },
    select: { id: true, discordChannelId: true },
  });
  const result: Array<{ id: string; channelId: string }> = [];
  for (const d of divisions) {
    if (!d.discordChannelId) continue;
    divisionChannelIds.set(d.discordChannelId, d.id);
    result.push({ id: d.id, channelId: d.discordChannelId });
  }
  return result;
}

async function tickDivision(client: Client, division: { id: string; channelId: string }): Promise<void> {
  try {
    const ch = await client.channels.fetch(division.channelId).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) return;
    const channel = ch as TextChannel;

    const key = stickyConfigKey(division.id);
    const existing = await prisma.leagueConfig.findUnique({ where: { key } });
    const storedId = existing?.value ?? null;

    // Never posted (fresh division, or the sticky was manually removed from
    // config) -- post immediately, no throttle. There's nothing to interrupt
    // by adding one message to a channel that has none of ours yet.
    if (!storedId) {
      await postSticky(channel, division.id);
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
    await postSticky(channel, division.id);
  } catch (err) {
    logDiscordError("sticky-actions.tickDivision", err, { channelId: division.channelId });
  }
}

async function runStickyTick(client: Client): Promise<void> {
  try {
    const divisions = await refreshDivisionChannelIds();
    for (const division of divisions) {
      await tickDivision(client, division);
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
