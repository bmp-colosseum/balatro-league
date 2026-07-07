// Discord wrappers for bot-side workers. Uses the long-running discord.js
// Client (gateway + REST) instead of @discordjs/rest — the Client already
// handles bucket-aware rate limits, caches Guild objects, and is the
// natural fit for code running inside the bot process.
//
// Shape mirrors web/lib/discord.ts so worker code reads similarly to the
// web's sync version. Each helper swallows errors and returns null/false
// so callers (workers, sweepers) decide whether to retry vs continue.

import {
  ChannelType,
  PermissionFlagsBits,
  type BaseMessageOptions,
  type CategoryChannel,
  type Guild,
} from "discord.js";
import { getConfig, setConfig, type LeagueConfigKey } from "./league-config.js";

// Permission sets used by the bootstrap. Granting these explicitly via
// overwrite means league functionality doesn't quietly break when the
// server admin restricts @everyone defaults (e.g. removing
// UseApplicationCommands at the server level would otherwise prevent
// slash commands from working in division channels).
//
// MEMBER_ALLOW: what a player needs to participate fully in their
// division channel — see history, post, attach screenshots, use slash
// commands, react with emoji.
//
// BOT_ALLOW: what the bot needs in any channel it created (including
// match-flow surfaces). Mirrors the boot-audit perm list + the thread
// management it does post-match.
const MEMBER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.UseApplicationCommands,
];

const BOT_ALLOW = [
  ...MEMBER_ALLOW,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.CreatePublicThreads,
];

// Staff (admin/helper) on a division channel. The key bit is ManageThreads:
// Discord can't grant a ROLE access to a private thread, but anyone with
// ManageThreads on the parent channel sees EVERY private thread in it — so any
// private threads are visible to all staff (current + future, since it's
// role-based) with no per-thread member adds and no sync job.
const STAFF_ALLOW = [
  ...MEMBER_ALLOW,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageMessages,
];

export const PERM_PRESETS = { MEMBER_ALLOW, BOT_ALLOW, STAFF_ALLOW } as const;
import { getDiscordClient } from "./discord.js";

async function getGuild(guildId: string): Promise<Guild> {
  return await getDiscordClient().guilds.fetch(guildId);
}

export async function createGuildRole(
  guildId: string,
  name: string,
  opts?: { color?: number; mentionable?: boolean },
): Promise<{ id: string } | null> {
  try {
    const guild = await getGuild(guildId);
    const role = await guild.roles.create({
      name,
      color: opts?.color ?? 0,
      mentionable: opts?.mentionable ?? true,
    });
    return { id: role.id };
  } catch (err) {
    console.warn(`[bot] createGuildRole(${name}) failed:`, err);
    return null;
  }
}

// A real Discord user id is a numeric snowflake (17-20 digits). Seeded/test
// players use non-numeric ids (e.g. "e2e-75"); calling Discord with those
// throws 50035 "not snowflake" and racks up invalid requests (ban risk), so
// we short-circuit before ever hitting the API.
const SNOWFLAKE_RE = /^\d{17,20}$/;
export function isDiscordSnowflake(id: string): boolean {
  return SNOWFLAKE_RE.test(id);
}

// True when a DM send failed for a PERMANENT reason — the recipient can't be
// DM'd at all (DMs off, blocked the bot, no shared server / "no mutual guilds"),
// or isn't a real user. These must NOT be retried: a retry can never succeed and
// the job just sits as a failure. Matches both the numeric code (50007 = can't
// DM, 10013 = unknown user) AND the message text, since the "no mutual guilds"
// variant doesn't always surface a parseable code.
export function isUndeliverableDm(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  if (code === 50007 || code === 10013) return true;
  const msg = String((err as { message?: unknown })?.message ?? "");
  return /no mutual guilds|cannot send messages to this user/i.test(msg);
}

export async function addGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
): Promise<boolean> {
  if (!isDiscordSnowflake(userId)) return false; // not a real Discord user (e.g. seeded player)
  try {
    const guild = await getGuild(guildId);
    const member = await guild.members.fetch(userId);
    await member.roles.add(roleId);
    return true;
  } catch (err) {
    console.warn(`[bot] addGuildMemberRole(${userId}, ${roleId}) failed:`, err);
    return false;
  }
}

// Remove ONE role from ONE member. Idempotent — if the player isn't in
// the guild anymore (left/kicked) or doesn't have the role, the call
// silently succeeds. Used by the end-of-season role-cleanup fanout.
export async function removeGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
): Promise<boolean> {
  if (!isDiscordSnowflake(userId)) return true; // not a real Discord user — nothing to remove
  try {
    const guild = await getGuild(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return true; // player left the guild — nothing to do
    if (!member.roles.cache.has(roleId)) return true; // already doesn't have it
    await member.roles.remove(roleId);
    return true;
  } catch (err) {
    console.warn(`[bot] removeGuildMemberRole(${userId}, ${roleId}) failed:`, err);
    return false;
  }
}

export async function ensureGuildCategory(
  guildId: string,
  name: string,
): Promise<{ id: string } | null> {
  try {
    const guild = await getGuild(guildId);
    const channels = await guild.channels.fetch();
    const lower = name.toLowerCase();
    const existing = channels.find(
      (c): c is CategoryChannel => c?.type === ChannelType.GuildCategory && c.name.toLowerCase() === lower,
    );
    if (existing) return { id: existing.id };
    const created = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    return { id: created.id };
  } catch (err) {
    console.warn(`[bot] ensureGuildCategory(${name}) failed:`, err);
    return null;
  }
}

// Resolve the category the bot should put its channels under, config-first:
//   1. If `configKey` holds an id that still resolves to a category, use it.
//      (Lets an admin point the bot at an existing category on a server it
//      didn't create, via /admin/config.)
//   2. Otherwise find-or-create one named `fallbackName` and persist its id
//      back to `configKey` so later auto-creates + the web reference the same
//      category.
export async function resolveConfiguredCategory(
  guildId: string,
  configKey: LeagueConfigKey,
  fallbackName: string,
): Promise<{ id: string } | null> {
  const configured = await getConfig(configKey);
  if (configured) {
    try {
      const guild = await getGuild(guildId);
      const ch = await guild.channels.fetch(configured).catch(() => null);
      if (ch && ch.type === ChannelType.GuildCategory) return { id: configured };
    } catch {
      // fall through to name-based find-or-create
    }
  }
  const cat = await ensureGuildCategory(guildId, fallbackName);
  if (cat && cat.id !== configured) {
    await setConfig(configKey, cat.id, "category-auto-resolve").catch(() => {});
  }
  return cat;
}

export async function createGuildTextChannel(
  guildId: string,
  name: string,
  opts?: {
    parentId?: string;
    topic?: string;
    visibleToRoleIds?: string[];
    // Staff roles that get STAFF_ALLOW (incl. ManageThreads) instead of plain
    // MEMBER_ALLOW — so they can see every private thread in here.
    staffRoleIds?: string[];
    // Specific guild members who get view + send. Used for per-match
    // private channels — same effect as visibleToRoleIds but scoped to
    // individual users instead of a role. discord.js infers OverwriteType
    // by snowflake but we pass it explicitly to avoid ambiguity.
    visibleToUserIds?: string[];
  },
): Promise<{ id: string } | null> {
  try {
    const guild = await getGuild(guildId);
    const staffRoles = opts?.staffRoleIds?.filter(Boolean) ?? [];
    // Plain members get MEMBER_ALLOW; staff (passed separately) get STAFF_ALLOW.
    // Dedupe so a role passed as both doesn't get two overwrites.
    const visibleRoles = (opts?.visibleToRoleIds?.filter(Boolean) ?? []).filter((id) => !staffRoles.includes(id));
    const visibleUsers = opts?.visibleToUserIds?.filter(Boolean) ?? [];
    const hasAnyOverwrite = visibleRoles.length > 0 || staffRoles.length > 0 || visibleUsers.length > 0;
    // ALWAYS include the bot itself in private channels — otherwise the
    // @everyone deny ViewChannel applies to it too and it can't post
    // the match flow into the channel it just created. Trickled silently
    // before this fix: channel appeared, message didn't.
    const botUserId = getDiscordClient().user?.id;
    if (hasAnyOverwrite && botUserId && !visibleUsers.includes(botUserId)) {
      visibleUsers.push(botUserId);
    }
    const permissionOverwrites = hasAnyOverwrite
      ? [
          { id: guildId, type: 0 as const, deny: [PermissionFlagsBits.ViewChannel] },
          ...visibleRoles.map((id) => ({
            id,
            type: 0 as const,
            // Full MEMBER_ALLOW set so slash commands, embeds, history,
            // attachments etc. work regardless of @everyone server-
            // level defaults.
            allow: [...MEMBER_ALLOW],
          })),
          ...staffRoles.map((id) => ({
            id,
            type: 0 as const,
            // STAFF_ALLOW adds ManageThreads so staff see every private
            // thread in this channel without being added to each.
            allow: [...STAFF_ALLOW],
          })),
          ...visibleUsers.map((id) => ({
            id,
            type: 1 as const,
            // The bot is added as a user overwrite; give it the wider
            // BOT_ALLOW set so it can also manage threads + delete its
            // own messages from inside the channel it created.
            allow: id === botUserId ? [...BOT_ALLOW] : [...MEMBER_ALLOW],
          })),
        ]
      : undefined;
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: opts?.parentId,
      topic: opts?.topic,
      permissionOverwrites,
    });
    return { id: channel.id };
  } catch (err) {
    console.warn(`[bot] createGuildTextChannel(${name}) failed:`, err);
    return null;
  }
}

export async function postChannelMessage(
  channelId: string,
  content: string,
  // Default never pings — a stray @everyone / user mention (e.g. via a user-set
  // display name) renders as inert text. Pass pingRole=true to notify the ROLE
  // @mention in the content (only roles — never @everyone/here/users), e.g. the
  // division welcome at season kickoff pings one @division role, not each member.
  pingRole = false,
  components?: BaseMessageOptions["components"],
): Promise<string | null> {
  try {
    const channel = await getDiscordClient().channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    const msg = await channel.send({
      content,
      allowedMentions: { parse: pingRole ? ["roles"] : [] },
      components,
    });
    return msg.id;
  } catch (err) {
    console.warn(`[bot] postChannelMessage(${channelId}) failed:`, err);
    return null;
  }
}

// Delete a message we posted (best-effort) — used when re-posting a fresh
// (pinging) welcome to replace the old silent one.
export async function deleteChannelMessage(channelId: string, messageId: string): Promise<boolean> {
  try {
    const channel = await getDiscordClient().channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return false;
    const msg = await channel.messages.fetch(messageId);
    await msg.delete();
    return true;
  } catch (err) {
    console.warn(`[bot] deleteChannelMessage(${channelId}/${messageId}) failed:`, err);
    return false;
  }
}

// Pin a message we posted (best-effort, idempotent). Discord no-ops a re-pin, so
// this is safe to call on every welcome refresh to keep it pinned.
export async function pinChannelMessage(channelId: string, messageId: string): Promise<boolean> {
  try {
    const channel = await getDiscordClient().channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return false;
    const msg = await channel.messages.fetch(messageId);
    if (msg.pinned) return true;
    await msg.pin();
    return true;
  } catch (err) {
    console.warn(`[bot] pinChannelMessage(${channelId}/${messageId}) failed:`, err);
    return false;
  }
}

// Find the bot's existing welcome post in a channel (by author + the "# 🃏 Welcome
// to" header) so we can adopt its id and edit in place — for channels bootstrapped
// before we started storing the message id. Returns the oldest match (the welcome
// is the first thing posted). Null if none.
export async function findWelcomeMessageId(channelId: string): Promise<string | null> {
  try {
    const client = getDiscordClient();
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return null;
    const botId = client.user?.id;
    const msgs = await channel.messages.fetch({ limit: 50 });
    const welcome = [...msgs.values()]
      .filter((m) => m.author.id === botId && m.content.startsWith("# 🃏 Welcome to"))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
    return welcome?.id ?? null;
  } catch (err) {
    console.warn(`[bot] findWelcomeMessageId(${channelId}) failed:`, err);
    return null;
  }
}

// Edit an existing message in place — ping-free, like postChannelMessage. Returns
// false if the channel/message is gone (caller can re-post). Used to refresh a
// division's welcome content without re-posting (so nobody gets re-pinged).
export async function editChannelMessage(
  channelId: string,
  messageId: string,
  content: string,
  components?: BaseMessageOptions["components"],
): Promise<boolean> {
  try {
    const channel = await getDiscordClient().channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return false;
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ content, allowedMentions: { parse: [] }, components });
    return true;
  } catch (err) {
    console.warn(`[bot] editChannelMessage(${channelId}/${messageId}) failed:`, err);
    return false;
  }
}

