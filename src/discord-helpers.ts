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
  opts?: { parentId?: string; topic?: string; visibleToRoleIds?: string[] },
): Promise<{ id: string } | null> {
  try {
    const guild = await getGuild(guildId);
    const visible = opts?.visibleToRoleIds?.filter(Boolean) ?? [];
    const permissionOverwrites = visible.length > 0
      ? [
          { id: guildId, deny: [PermissionFlagsBits.ViewChannel] },
          ...visible.map((id) => ({
            id,
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
): Promise<string | null> {
  try {
    const channel = await getDiscordClient().channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    const msg = await channel.send({ content });
    return msg.id;
  } catch (err) {
    console.warn(`[bot] postChannelMessage(${channelId}) failed:`, err);
    return null;
  }
}
