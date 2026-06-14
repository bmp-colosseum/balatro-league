// Web-side Discord REST client. Uses @discordjs/rest so bucket-aware
// throttling, X-RateLimit-* header parsing, and 429 retries are handled
// automatically — same library discord.js uses internally for the bot.
//
// Exposes thin wrappers so callers keep the same shape as before.

import { REST } from "@discordjs/rest";
import {
  ChannelType,
  Routes,
  type APIChannel,
  type APIDMChannel,
  type APIGuildMember,
  type APIInvite,
  type APIMessage,
  type APIRole,
  type APIUser,
  type RESTPostAPIChannelMessageJSONBody,
  type RESTPostAPIGuildChannelJSONBody,
  type RESTPostAPIGuildRoleJSONBody,
} from "discord-api-types/v10";

let singleton: REST | null = null;
function rest(): REST {
  if (!singleton) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error("DISCORD_TOKEN env var not set");
    // REST defaults: bucket-aware throttling on, retries 429s with Retry-After,
    // queues per-route when bucket is empty. No additional config needed for our scale.
    singleton = new REST({ version: "10" }).setToken(token);
  }
  return singleton;
}

interface DiscordMember {
  user?: { id: string; username: string; global_name?: string | null };
  nick?: string | null;
  roles: string[];
}

export async function fetchGuildMember(guildId: string, userId: string): Promise<DiscordMember | null> {
  try {
    return (await rest().get(Routes.guildMember(guildId, userId))) as APIGuildMember;
  } catch (err) {
    if (isNotFound(err)) return null;
    console.warn(`Discord fetchGuildMember failed:`, err);
    return null;
  }
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export async function fetchDiscordUser(userId: string): Promise<DiscordUser | null> {
  try {
    return (await rest().get(Routes.user(userId))) as APIUser;
  } catch (err) {
    if (isNotFound(err)) return null;
    console.warn(`Discord fetchDiscordUser failed:`, err);
    return null;
  }
}

// Preferred display name for a user: account-level global name first, then
// the server nickname, then the @username. Prefers the real Discord identity
// over a server-specific nickname, matching the bot's guildDisplayName().
export async function resolveDisplayName(guildId: string | undefined, userId: string): Promise<string | null> {
  if (guildId) {
    const m = await fetchGuildMember(guildId, userId);
    if (m) return m.user?.global_name || m.nick || m.user?.username || null;
  }
  const u = await fetchDiscordUser(userId);
  if (u) return u.global_name || u.username || null;
  return null;
}

export interface MessageEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export interface ComponentButton {
  type: 2;
  custom_id: string;
  style: 1 | 2 | 3 | 4;
  label: string;
  disabled?: boolean;
}
export interface ComponentActionRow {
  type: 1;
  components: ComponentButton[];
}

export async function postChannelMessage(
  channelId: string,
  payload: { content?: string; embeds?: MessageEmbed[]; components?: ComponentActionRow[] },
): Promise<string | null> {
  try {
    const msg = (await rest().post(Routes.channelMessages(channelId), {
      body: payload as RESTPostAPIChannelMessageJSONBody,
    })) as APIMessage;
    return msg.id ?? null;
  } catch (err) {
    console.warn(`Discord postChannelMessage failed:`, err);
    return null;
  }
}

export async function editChannelMessage(
  channelId: string,
  messageId: string,
  payload: { content?: string; embeds?: MessageEmbed[]; components?: ComponentActionRow[] },
): Promise<boolean> {
  try {
    await rest().patch(Routes.channelMessage(channelId, messageId), { body: payload });
    return true;
  } catch (err) {
    console.warn(`Discord editChannelMessage failed:`, err);
    return false;
  }
}

// Open (or reuse) a DM channel with a user and post a message to it.
export async function sendDirectMessage(
  userId: string,
  payload: { content?: string; embeds?: MessageEmbed[]; components?: ComponentActionRow[] },
): Promise<boolean> {
  try {
    const dm = (await rest().post(Routes.userChannels(), { body: { recipient_id: userId } })) as APIDMChannel;
    if (!dm.id) return false;
    const msgId = await postChannelMessage(dm.id, payload);
    return msgId !== null;
  } catch (err) {
    console.warn(`Discord sendDirectMessage(${userId}) failed:`, err);
    return false;
  }
}

// Create a never-expiring invite to a channel.
export async function createChannelInvite(
  channelId: string,
  options?: { maxAge?: number; maxUses?: number },
): Promise<string | null> {
  try {
    const inv = (await rest().post(Routes.channelInvites(channelId), {
      body: {
        max_age: options?.maxAge ?? 0,
        max_uses: options?.maxUses ?? 0,
        unique: false,
      },
    })) as APIInvite;
    return inv.code ? `https://discord.gg/${inv.code}` : null;
  } catch (err) {
    console.warn(`Discord createChannelInvite(${channelId}) failed:`, err);
    return null;
  }
}

interface DiscordRole { id: string; name: string }

export async function createGuildRole(
  guildId: string,
  name: string,
  options?: { color?: number; mentionable?: boolean },
): Promise<DiscordRole | null> {
  try {
    const r = (await rest().post(Routes.guildRoles(guildId), {
      body: {
        name,
        color: options?.color ?? 0,
        mentionable: options?.mentionable ?? true,
      } as RESTPostAPIGuildRoleJSONBody,
    })) as APIRole;
    return { id: r.id, name: r.name };
  } catch (err) {
    console.warn(`Discord createGuildRole failed:`, err);
    return null;
  }
}

export async function addGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
  try {
    await rest().put(Routes.guildMemberRole(guildId, userId, roleId));
    return true;
  } catch (err) {
    console.warn(`Discord addGuildMemberRole(${userId}, ${roleId}) failed:`, err);
    return false;
  }
}

export async function removeGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
  try {
    await rest().delete(Routes.guildMemberRole(guildId, userId, roleId));
    return true;
  } catch (err) {
    if (isNotFound(err)) return true; // already removed
    console.warn(`Discord removeGuildMemberRole(${userId}, ${roleId}) failed:`, err);
    return false;
  }
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  position?: number;
}

export async function createGuildTextChannel(
  guildId: string,
  name: string,
  options?: { parentId?: string; topic?: string; visibleToRoleIds?: string[] },
): Promise<DiscordChannel | null> {
  // Permission flags as strings — Discord accepts the bitfield as a base-10
  // string in JSON. 1 << 10 = 1024 (VIEW_CHANNEL), 1 << 11 = 2048 (SEND_MESSAGES).
  const VIEW_CHANNEL = "1024";
  const VIEW_AND_SEND = "3072"; // 1024 | 2048
  const visibleToRoleIds = options?.visibleToRoleIds?.filter(Boolean) ?? [];
  const overwrites = visibleToRoleIds.length > 0
    ? [
        { id: guildId, type: 0, deny: VIEW_CHANNEL, allow: "0" },
        ...visibleToRoleIds.map((roleId) => ({
          id: roleId,
          type: 0,
          allow: VIEW_AND_SEND,
          deny: "0",
        })),
      ]
    : undefined;
  try {
    const ch = (await rest().post(Routes.guildChannels(guildId), {
      body: {
        name,
        type: ChannelType.GuildText,
        parent_id: options?.parentId,
        topic: options?.topic,
        permission_overwrites: overwrites,
      } as RESTPostAPIGuildChannelJSONBody,
    })) as APIChannel;
    return {
      id: ch.id,
      name: ("name" in ch ? ch.name : null) ?? name,
      type: ch.type,
      parent_id: "parent_id" in ch ? ch.parent_id : null,
    };
  } catch (err) {
    console.warn(`Discord createGuildTextChannel failed:`, err);
    return null;
  }
}

// Create or reuse a category by name (case-insensitive). Used by the
// season-bootstrap flow to give each season a clean home and by the
// archive flow to gather ended seasons' channels in one place.
export async function ensureGuildCategory(guildId: string, name: string): Promise<DiscordChannel | null> {
  try {
    const all = (await rest().get(Routes.guildChannels(guildId))) as APIChannel[];
    const existing = all.find(
      (c) => c.type === ChannelType.GuildCategory && "name" in c && c.name?.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      return { id: existing.id, name: ("name" in existing ? existing.name : null) ?? name, type: existing.type };
    }
    const created = (await rest().post(Routes.guildChannels(guildId), {
      body: { name, type: ChannelType.GuildCategory } as RESTPostAPIGuildChannelJSONBody,
    })) as APIChannel;
    return { id: created.id, name: ("name" in created ? created.name : null) ?? name, type: created.type };
  } catch (err) {
    console.warn(`Discord ensureGuildCategory(${name}) failed:`, err);
    return null;
  }
}

// Move a channel under a new parent. parentId=null moves to top level.
export async function setChannelParent(channelId: string, parentId: string | null): Promise<boolean> {
  try {
    await rest().patch(Routes.channel(channelId), { body: { parent_id: parentId } });
    return true;
  } catch (err) {
    console.warn(`Discord setChannelParent(${channelId} → ${parentId}) failed:`, err);
    return false;
  }
}

// Apply permission overwrite that DENIES @everyone SEND_MESSAGES on a
// channel — readable history, no new posts. Channel-level lock that
// any role with explicit allow can override.
export async function lockChannelForEveryone(guildId: string, channelId: string): Promise<boolean> {
  const SEND_MESSAGES = "2048"; // 1 << 11
  try {
    await rest().put(`${Routes.channel(channelId)}/permissions/${guildId}` as `/channels/${string}/permissions/${string}`, {
      body: { type: 0, allow: "0", deny: SEND_MESSAGES },
    });
    return true;
  } catch (err) {
    console.warn(`Discord lockChannelForEveryone(${channelId}) failed:`, err);
    return false;
  }
}

export async function listGuildTextChannels(guildId: string): Promise<DiscordChannel[]> {
  try {
    const all = (await rest().get(Routes.guildChannels(guildId))) as APIChannel[];
    return all
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({
        id: c.id,
        name: ("name" in c ? c.name : null) ?? "",
        type: c.type,
        parent_id: "parent_id" in c ? c.parent_id : null,
        position: "position" in c ? c.position : undefined,
      }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  } catch (err) {
    console.warn(`Discord listGuildTextChannels failed:`, err);
    return [];
  }
}

// List all active (non-archived) threads in the guild. Includes
// threads under any parent channel; caller filters to the relevant
// subset. APIThreadList.members is ignored — we only need thread ids
// and parent ids.
export async function listGuildActiveThreads(
  guildId: string,
): Promise<Array<{ id: string; name: string; parentId: string | null }>> {
  try {
    const result = (await rest().get(Routes.guildActiveThreads(guildId))) as {
      threads: Array<{ id: string; name?: string; parent_id?: string | null }>;
    };
    return result.threads.map((t) => ({
      id: t.id,
      name: t.name ?? "",
      parentId: t.parent_id ?? null,
    }));
  } catch (err) {
    console.warn(`Discord listGuildActiveThreads failed:`, err);
    return [];
  }
}

// List ARCHIVED public threads under a specific parent channel.
// Discord paginates with `before` (a timestamp); we walk up to 5 pages
// (500 threads) which is overkill for our scale. Used by the manual
// sweep to find threads Discord auto-archived but never deleted.
export async function listArchivedThreadsInChannel(
  channelId: string,
): Promise<Array<{ id: string; name: string; parentId: string }>> {
  const collected: Array<{ id: string; name: string; parentId: string }> = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    try {
      const path = before
        ? `/channels/${channelId}/threads/archived/public?before=${encodeURIComponent(before)}&limit=100`
        : `/channels/${channelId}/threads/archived/public?limit=100`;
      const result = (await rest().get(path as `/${string}`)) as {
        threads: Array<{ id: string; name?: string; thread_metadata?: { archive_timestamp?: string } }>;
        has_more?: boolean;
      };
      for (const t of result.threads) {
        collected.push({ id: t.id, name: t.name ?? "", parentId: channelId });
      }
      if (!result.has_more || result.threads.length === 0) break;
      const last = result.threads[result.threads.length - 1];
      before = last?.thread_metadata?.archive_timestamp;
      if (!before) break;
    } catch (err) {
      console.warn(`Discord listArchivedThreadsInChannel(${channelId}) failed:`, err);
      break;
    }
  }
  return collected;
}

// Delete a channel (thread or regular). Returns true on success or if
// the channel was already gone (404 treated as success — the cleanup
// goal is reached). Returns false on real errors (perms, network).
export async function deleteChannel(channelId: string): Promise<boolean> {
  try {
    await rest().delete(Routes.channel(channelId));
    return true;
  } catch (err) {
    if (isNotFound(err)) return true;
    console.warn(`Discord deleteChannel(${channelId}) failed:`, err);
    return false;
  }
}

// List ALL channels (text, voice, category, etc.) in a guild. The
// existing listGuildTextChannels filters to text-only; the destructive
// wipe needs to also see categories so it can find + delete them.
export async function listAllGuildChannels(guildId: string): Promise<Array<{
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
}>> {
  try {
    const all = (await rest().get(Routes.guildChannels(guildId))) as APIChannel[];
    return all.map((c) => ({
      id: c.id,
      name: ("name" in c ? c.name : null) ?? "",
      type: c.type as number,
      parent_id: "parent_id" in c ? (c.parent_id ?? null) : null,
    }));
  } catch (err) {
    console.warn(`Discord listAllGuildChannels failed:`, err);
    return [];
  }
}

export async function listGuildRoles(guildId: string): Promise<Array<{
  id: string;
  name: string;
  managed: boolean;
}>> {
  try {
    const roles = (await rest().get(Routes.guildRoles(guildId))) as Array<{
      id: string;
      name: string;
      managed?: boolean;
    }>;
    return roles.map((r) => ({ id: r.id, name: r.name, managed: r.managed ?? false }));
  } catch (err) {
    console.warn(`Discord listGuildRoles failed:`, err);
    return [];
  }
}

export async function deleteGuildRole(guildId: string, roleId: string): Promise<boolean> {
  try {
    await rest().delete(Routes.guildRole(guildId, roleId));
    return true;
  } catch (err) {
    if (isNotFound(err)) return true;
    console.warn(`Discord deleteGuildRole(${roleId}) failed:`, err);
    return false;
  }
}

// True for the discord.js DiscordAPIError shape when Discord returns 404.
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}

