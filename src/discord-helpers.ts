// Discord wrappers for bot-side workers. Uses the long-running discord.js
// Client (gateway + REST) instead of @discordjs/rest — the Client already
// handles bucket-aware rate limits, caches Guild objects, and is the
// natural fit for code running inside the bot process.
//
// Shape mirrors web/lib/discord.ts so worker code reads similarly to the
// web's sync version. Each helper swallows errors and returns null/false
// so callers (workers, sweepers) decide whether to retry vs continue.

import { ChannelType, PermissionFlagsBits, type CategoryChannel, type Guild } from "discord.js";
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

export async function addGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
): Promise<boolean> {
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

export async function createGuildTextChannel(
  guildId: string,
  name: string,
  opts?: {
    parentId?: string;
    topic?: string;
    visibleToRoleIds?: string[];
    // Specific guild members who get view + send. Used for per-match
    // private channels — same effect as visibleToRoleIds but scoped to
    // individual users instead of a role. discord.js infers OverwriteType
    // by snowflake but we pass it explicitly to avoid ambiguity.
    visibleToUserIds?: string[];
  },
): Promise<{ id: string } | null> {
  try {
    const guild = await getGuild(guildId);
    const visibleRoles = opts?.visibleToRoleIds?.filter(Boolean) ?? [];
    const visibleUsers = opts?.visibleToUserIds?.filter(Boolean) ?? [];
    const hasAnyOverwrite = visibleRoles.length > 0 || visibleUsers.length > 0;
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
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
          })),
          ...visibleUsers.map((id) => ({
            id,
            type: 1 as const,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
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
  opts: { silent?: boolean } = {},
): Promise<string | null> {
  try {
    const channel = await getDiscordClient().channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    // silent=true keeps any <@id>/<@&id> in the message rendering as
    // clickable mentions but DOESN'T fire a notification or in-app ping.
    // Used by setup messages (bootstrap welcomes, etc.) where the
    // reference is useful but pinging everyone in the channel is noise.
    const msg = await channel.send({
      content,
      ...(opts.silent ? { allowedMentions: { parse: [] } } : {}),
    });
    return msg.id;
  } catch (err) {
    console.warn(`[bot] postChannelMessage(${channelId}) failed:`, err);
    return null;
  }
}
