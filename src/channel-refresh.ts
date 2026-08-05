// Re-render the bot's two pinned/read-only info posts: #league-info and
// #league-standings. Pulled out of queue.ts — the league-info.refresh and
// standings.refresh pg-boss workers call these, but the rendering logic is pure
// Discord-message reconciliation with no queue concerns.

import { tryGetDiscordClient } from "./discord.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { composeLeagueInfoContent } from "./league-info-content.js";
import { composeChallengeInfoContent } from "./challenge-info-content.js";
import { composeStandingsEmbeds } from "./standings-channel-content.js";
import type { BotHealth } from "./bot-health.js"; // type-only -- avoids a runtime import cycle with bot-health.ts
import { buildPublicHealthEmbed, buildBotStatusRenderKey } from "./bot-status-content.js";

// Rebuild + edit the pinned #league-info message. Idempotent — pulls
// fresh DB state via composeLeagueInfoContent every invocation, so
// multiple triggers fold into the same result. Looks for the bot's
// own pinned message first; falls back to posting + pinning a new one
// if none exists.
export async function refreshLeagueInfoPinned(): Promise<void> {
  const channelId = await getConfig(LeagueConfigKey.LeagueInfoChannelId);
  if (!channelId) {
    console.warn("[league-info.refresh] no LeagueInfoChannelId set — skipping");
    return;
  }
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[league-info.refresh] Discord client not ready — skipping");
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.warn(`[league-info.refresh] channel ${channelId} not found or unusable`);
    return;
  }
  const content = await composeLeagueInfoContent();
  const botId = client.user?.id;
  type MiniMsg = { id: string; author: { id: string }; edit: (o: { content: string }) => Promise<unknown>; pin: () => Promise<unknown> };
  const messages = (channel as {
    messages: {
      fetch: (id: string) => Promise<MiniMsg>;
      fetchPinned: () => Promise<{ values: () => Iterable<MiniMsg> }>;
    };
    send: (o: { content: string }) => Promise<MiniMsg>;
  });
  try {
    // 1. Edit the remembered message if it still exists — keyed on a stored
    //    id, NOT on pin state, so an unpinned message can't cause a dupe.
    const storedId = await getConfig(LeagueConfigKey.LeagueInfoMessageId);
    if (storedId) {
      const existing = await messages.messages.fetch(storedId).catch(() => null);
      if (existing && existing.author.id === botId) {
        await existing.edit({ content });
        return;
      }
    }
    // 2. No stored id (or it's gone) — adopt an existing pinned bot message
    //    if there is one (migration path), so we don't post a duplicate.
    const pinned = await messages.messages.fetchPinned().catch(() => null);
    if (pinned) {
      for (const msg of pinned.values()) {
        if (msg.author.id === botId) {
          await msg.edit({ content });
          await setConfig(LeagueConfigKey.LeagueInfoMessageId, msg.id, "league-info.refresh");
          return;
        }
      }
    }
    // 3. Nothing to edit — post + pin a new one and remember its id.
    const sent = await messages.send({ content });
    await sent.pin().catch((err: unknown) => console.warn("[league-info.refresh] pin failed:", err));
    await setConfig(LeagueConfigKey.LeagueInfoMessageId, sent.id, "league-info.refresh");
    console.log(`[league-info.refresh] posted + pinned new message in ${channelId}`);
  } catch (err) {
    console.warn(`[league-info.refresh] failed: ${(err as Error).message}`);
  }
}

// Keep the "how challenges work" post current in the challenges channel. Same
// reconciliation as refreshLeagueInfoPinned (edit a remembered message id →
// adopt an existing pinned bot message → post+pin a new one), so it never
// duplicates and heals a lost pin. No-ops if no challenges channel is set.
export async function refreshChallengeInfoPinned(): Promise<void> {
  const channelId = await getConfig(LeagueConfigKey.ChallengesChannelId);
  if (!channelId) return; // challenges channel not configured — nothing to do
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[challenge-info.refresh] Discord client not ready — skipping");
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.warn(`[challenge-info.refresh] channel ${channelId} not found or unusable`);
    return;
  }
  const content = composeChallengeInfoContent();
  const botId = client.user?.id;
  type MiniMsg = { id: string; author: { id: string }; edit: (o: { content: string }) => Promise<unknown>; pin: () => Promise<unknown> };
  const messages = channel as {
    messages: {
      fetch: (id: string) => Promise<MiniMsg>;
      fetchPinned: () => Promise<{ values: () => Iterable<MiniMsg> }>;
    };
    send: (o: { content: string }) => Promise<MiniMsg>;
  };
  try {
    const storedId = await getConfig(LeagueConfigKey.ChallengeInfoMessageId);
    if (storedId) {
      const existing = await messages.messages.fetch(storedId).catch(() => null);
      if (existing && existing.author.id === botId) {
        await existing.edit({ content });
        return;
      }
    }
    const pinned = await messages.messages.fetchPinned().catch(() => null);
    if (pinned) {
      for (const msg of pinned.values()) {
        if (msg.author.id === botId) {
          await msg.edit({ content });
          await setConfig(LeagueConfigKey.ChallengeInfoMessageId, msg.id, "challenge-info.refresh");
          return;
        }
      }
    }
    const sent = await messages.send({ content });
    await sent.pin().catch((err: unknown) => console.warn("[challenge-info.refresh] pin failed:", err));
    await setConfig(LeagueConfigKey.ChallengeInfoMessageId, sent.id, "challenge-info.refresh");
    console.log(`[challenge-info.refresh] posted + pinned new message in ${channelId}`);
  } catch (err) {
    console.warn(`[challenge-info.refresh] failed: ${(err as Error).message}`);
  }
}

// Re-render the read-only #league-standings post. Standings can span several
// messages (Discord caps embeds at 10/message), so we keep an ordered list of
// the bot's message ids: edit the i-th in place, post a new one if we grew, and
// delete any trailing leftovers if the division count shrank. Idempotent —
// recomputes from current DB state every run.
export async function refreshStandingsMessages(): Promise<void> {
  const channelId = await getConfig(LeagueConfigKey.StandingsChannelId);
  if (!channelId) return; // standings feed not configured — nothing to do
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[standings.refresh] Discord client not ready — skipping");
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.warn(`[standings.refresh] channel ${channelId} not found or unusable`);
    return;
  }
  const embeds = await composeStandingsEmbeds();
  // Chunk into messages of <=10 embeds (Discord's per-message limit).
  const groups: (typeof embeds)[] = [];
  for (let i = 0; i < embeds.length; i += 10) groups.push(embeds.slice(i, i + 10));

  const botId = client.user?.id;
  type MiniMsg = {
    id: string;
    author: { id: string };
    edit: (o: { embeds: typeof embeds }) => Promise<unknown>;
    delete: () => Promise<unknown>;
  };
  const ch = channel as {
    messages: { fetch: (id: string) => Promise<MiniMsg> };
    send: (o: { embeds: typeof embeds }) => Promise<MiniMsg>;
  };

  const storedRaw = await getConfig(LeagueConfigKey.StandingsMessageIds);
  let storedIds: string[] = [];
  try {
    storedIds = storedRaw ? JSON.parse(storedRaw) : [];
  } catch {
    storedIds = [];
  }

  try {
    const newIds: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const existingId = storedIds[i];
      if (existingId) {
        const existing = await ch.messages.fetch(existingId).catch(() => null);
        if (existing && existing.author.id === botId) {
          await existing.edit({ embeds: groups[i]! });
          newIds.push(existingId);
          continue;
        }
      }
      const sent = await ch.send({ embeds: groups[i]! });
      newIds.push(sent.id);
    }
    // Delete trailing messages we no longer need (division count shrank).
    for (let i = groups.length; i < storedIds.length; i++) {
      await ch.messages.fetch(storedIds[i]!).then((m) => m.delete()).catch(() => {});
    }
    await setConfig(LeagueConfigKey.StandingsMessageIds, JSON.stringify(newIds), "standings.refresh");
  } catch (err) {
    console.warn(`[standings.refresh] failed: ${(err as Error).message}`);
  }
}

// -- Bot-status channel message ---------------------------------------------
//
// Keeps a single self-updating embed in BotStatusChannelId current with a
// BotHealth snapshot. Callers pass the snapshot BY VALUE (impure gather in
// the caller, e.g. bot-health.ts's runHealthTick reading its own
// cachedHealth, or league.ts's refresh-messages reading getCachedHealth())
// rather than this module importing bot-health.ts itself -- that keeps this
// a plain function of its inputs and avoids a channel-refresh <-> bot-health
// import cycle. Same reconciliation as refreshLeagueInfoPinned/
// refreshChallengeInfoPinned (edit a remembered message id -> adopt an
// existing pinned bot message -> post + pin a new one), so it never
// duplicates and heals a lost pin. No-ops cleanly when BotStatusChannelId is
// unset or health is null (no snapshot cached yet, e.g. right after boot).
//
// PLAYER-FACING: this channel is read by everyone, so it always renders
// bot-status-content.ts's buildPublicHealthEmbed (plain language, no
// ms/percentage numbers, no queue names) -- never the admin buildHealthEmbed.
//
// THROTTLE: bot-health.ts's tick calls this every 60s, but editing a Discord
// message on every tick (1440x/day) would be wasteful -- and actively
// harmful during exactly the kind of incident this message reports (Discord
// REST slowness), since editing more only adds load. buildBotStatusRenderKey
// summarizes the MATERIAL parts of the snapshot -- i.e. exactly what the
// PUBLIC embed renders (level + player-impact for a degraded snapshot) --
// this function only performs the edit when that key changes since the last
// actual edit, mirroring bot-health.ts's lastPresenceKey pattern. The
// embed's own "Last checked <t:...:R>" timestamp keeps the message looking
// fresh between edits without needing one, client-side.
// BOT_STATUS_MAX_STALENESS_MS is a backstop: if nothing material has
// changed for that long, force an edit anyway so the message can't look
// frozen forever on a very steady system.
export const BOT_STATUS_MAX_STALENESS_MS = 30 * 60 * 1000; // 30 minutes

let lastBotStatusRenderKey: string | null = null;
let lastBotStatusEditAt: number | null = null;

export async function refreshBotStatusMessage(health: BotHealth | null): Promise<void> {
  if (!health) return; // no snapshot cached yet (e.g. right after boot)
  const channelId = await getConfig(LeagueConfigKey.BotStatusChannelId);
  if (!channelId) return; // bot-status feed not configured -- nothing to do

  const key = buildBotStatusRenderKey(health);
  const now = Date.now();
  const stale = lastBotStatusEditAt === null || now - lastBotStatusEditAt > BOT_STATUS_MAX_STALENESS_MS;
  if (key === lastBotStatusRenderKey && !stale) return; // nothing material changed and not overdue -- skip the edit

  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[bot-status.refresh] Discord client not ready -- skipping");
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.warn(`[bot-status.refresh] channel ${channelId} not found or unusable`);
    return;
  }
  const embed = buildPublicHealthEmbed(health);
  const botId = client.user?.id;
  type MiniMsg = {
    id: string;
    author: { id: string };
    edit: (o: { embeds: [ReturnType<typeof buildPublicHealthEmbed>] }) => Promise<unknown>;
    pin: () => Promise<unknown>;
  };
  const messages = channel as {
    messages: {
      fetch: (id: string) => Promise<MiniMsg>;
      fetchPinned: () => Promise<{ values: () => Iterable<MiniMsg> }>;
    };
    send: (o: { embeds: [ReturnType<typeof buildPublicHealthEmbed>] }) => Promise<MiniMsg>;
  };
  try {
    // 1. Edit the remembered message if it still exists -- keyed on a stored
    //    id, NOT on pin state, so an unpinned message can't cause a dupe.
    const storedId = await getConfig(LeagueConfigKey.BotStatusMessageId);
    if (storedId) {
      const existing = await messages.messages.fetch(storedId).catch(() => null);
      if (existing && existing.author.id === botId) {
        await existing.edit({ embeds: [embed] });
        lastBotStatusRenderKey = key;
        lastBotStatusEditAt = now;
        return;
      }
    }
    // 2. No stored id (or it's gone) -- adopt an existing pinned bot message
    //    if there is one (migration path), so we don't post a duplicate.
    const pinned = await messages.messages.fetchPinned().catch(() => null);
    if (pinned) {
      for (const msg of pinned.values()) {
        if (msg.author.id === botId) {
          await msg.edit({ embeds: [embed] });
          await setConfig(LeagueConfigKey.BotStatusMessageId, msg.id, "bot-status.refresh");
          lastBotStatusRenderKey = key;
          lastBotStatusEditAt = now;
          return;
        }
      }
    }
    // 3. Nothing to edit -- post + pin a new one and remember its id.
    const sent = await messages.send({ embeds: [embed] });
    await sent.pin().catch((err: unknown) => console.warn("[bot-status.refresh] pin failed:", err));
    await setConfig(LeagueConfigKey.BotStatusMessageId, sent.id, "bot-status.refresh");
    lastBotStatusRenderKey = key;
    lastBotStatusEditAt = now;
    console.log(`[bot-status.refresh] posted + pinned new message in ${channelId}`);
  } catch (err) {
    console.warn(`[bot-status.refresh] failed: ${(err as Error).message}`);
  }
}
