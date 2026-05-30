// Thin Discord REST helpers used by the web app.
// We don't want a full discord.js client here (heavy, expects a long-running
// gateway connection). We just need HTTP calls authenticated with the bot token.

const BASE_URL = "https://discord.com/api/v10";

function botAuthHeader(): string {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN env var not set");
  return `Bot ${token}`;
}

interface DiscordMember {
  user?: { id: string; username: string };
  nick?: string | null;
  roles: string[]; // role IDs the member has in this guild
}

// Fetch a guild member. Returns null if the user isn't in the guild
// (Discord returns 404) or if the bot doesn't have access.
export async function fetchGuildMember(
  guildId: string,
  userId: string,
): Promise<DiscordMember | null> {
  const res = await fetch(`${BASE_URL}/guilds/${guildId}/members/${userId}`, {
    headers: { Authorization: botAuthHeader() },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`Discord fetchGuildMember failed: ${res.status} ${await res.text()}`);
    return null;
  }
  return res.json() as Promise<DiscordMember>;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null; // Discord's new display name (since 2023)
  avatar?: string | null;
}

// Fetch a Discord user globally — works for ANY user ID regardless of
// guild membership. Use when we just need a name for someone the bot
// can see at all (signed up but not in the server, etc.). Bot uses its
// own auth so the lookup doesn't depend on the target being in our guild.
export async function fetchDiscordUser(userId: string): Promise<DiscordUser | null> {
  const res = await fetch(`${BASE_URL}/users/${userId}`, {
    headers: { Authorization: botAuthHeader() },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`Discord fetchDiscordUser failed: ${res.status} ${await res.text()}`);
    return null;
  }
  return res.json() as Promise<DiscordUser>;
}

// Preferred display name for a user ID. Tries guild member first (so we
// get the server-specific nick if set), falls back to global user
// (so we still work for non-members). Returns null only if Discord
// has no record of the user at all.
export async function resolveDisplayName(guildId: string | undefined, userId: string): Promise<string | null> {
  if (guildId) {
    const m = await fetchGuildMember(guildId, userId);
    if (m) return m.nick || m.user?.username || null;
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

// Discord component-v1 (legacy) action row + button JSON shapes.
// type 1 = ActionRow, type 2 = Button. Styles: 1=Primary, 2=Secondary, 3=Success, 4=Danger.
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

// Post a message to a Discord channel. Returns the new message id on success, null on failure.
export async function postChannelMessage(
  channelId: string,
  payload: { content?: string; embeds?: MessageEmbed[]; components?: ComponentActionRow[] },
): Promise<string | null> {
  const res = await discordFetch(`${BASE_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: botAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn(`Discord postChannelMessage failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const body = (await res.json()) as { id?: string };
  return body.id ?? null;
}

// Edit an existing message (replace content/embeds/components).
export async function editChannelMessage(
  channelId: string,
  messageId: string,
  payload: { content?: string; embeds?: MessageEmbed[]; components?: ComponentActionRow[] },
): Promise<boolean> {
  const res = await discordFetch(`${BASE_URL}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: botAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn(`Discord editChannelMessage failed: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

// Wrapper that retries once on HTTP 429 (rate limit), honoring Retry-After.
// Discord's rate limits are bucketed per route; for low-volume admin actions
// one polite retry is usually enough.
async function discordFetch(url: string, init: RequestInit): Promise<Response> {
  let res = await fetch(url, init);
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("retry-after") ?? "1");
    const waitMs = Math.min(5000, Math.max(100, retryAfter * 1000));
    console.warn(`Discord 429 on ${url} — retrying after ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
    res = await fetch(url, init);
  }
  return res;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;       // 0 = GuildText, 4 = Category, 5 = Announcement, others = ignore
  parent_id?: string | null;
  position?: number;
}

interface DiscordRole {
  id: string;
  name: string;
}

// Create a role in a guild. Returns the new role's id.
export async function createGuildRole(
  guildId: string,
  name: string,
  options?: { color?: number; mentionable?: boolean },
): Promise<DiscordRole | null> {
  const res = await fetch(`${BASE_URL}/guilds/${guildId}/roles`, {
    method: "POST",
    headers: { Authorization: botAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      color: options?.color ?? 0,
      mentionable: options?.mentionable ?? true,
    }),
  });
  if (!res.ok) {
    console.warn(`Discord createGuildRole failed: ${res.status} ${await res.text()}`);
    return null;
  }
  return res.json() as Promise<DiscordRole>;
}

// Add a role to a guild member.
export async function addGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    headers: { Authorization: botAuthHeader() },
  });
  if (!res.ok) {
    console.warn(`Discord addGuildMemberRole(${userId}, ${roleId}) failed: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

// Create a guild text channel. If `visibleToRoleIds` is set, the channel is
// private — @everyone gets VIEW_CHANNEL denied and only the listed roles
// can see/send. Bot retains access via its own permissions.
export async function createGuildTextChannel(
  guildId: string,
  name: string,
  options?: { parentId?: string; topic?: string; visibleToRoleIds?: string[] },
): Promise<DiscordChannel | null> {
  const VIEW_CHANNEL = "1024"; // 1 << 10
  const SEND_MESSAGES = "2048"; // 1 << 11
  const allowMask = String((BigInt(VIEW_CHANNEL) | BigInt(SEND_MESSAGES)).toString());
  const visibleToRoleIds = options?.visibleToRoleIds?.filter(Boolean) ?? [];
  const overwrites = visibleToRoleIds.length > 0
    ? [
        // Deny @everyone (whose role id == guild id)
        { id: guildId, type: 0, deny: VIEW_CHANNEL, allow: "0" },
        // Allow each listed role to view + send
        ...visibleToRoleIds.map((roleId) => ({ id: roleId, type: 0, allow: allowMask, deny: "0" })),
      ]
    : undefined;
  const res = await fetch(`${BASE_URL}/guilds/${guildId}/channels`, {
    method: "POST",
    headers: { Authorization: botAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      type: 0,
      parent_id: options?.parentId,
      topic: options?.topic,
      permission_overwrites: overwrites,
    }),
  });
  if (!res.ok) {
    console.warn(`Discord createGuildTextChannel failed: ${res.status} ${await res.text()}`);
    return null;
  }
  return res.json() as Promise<DiscordChannel>;
}

// List text-like channels in a guild. Used by the admin signup-create form
// so admins can pick a channel without having to copy/paste an ID.
export async function listGuildTextChannels(guildId: string): Promise<DiscordChannel[]> {
  const res = await fetch(`${BASE_URL}/guilds/${guildId}/channels`, {
    headers: { Authorization: botAuthHeader() },
    cache: "no-store",
  });
  if (!res.ok) {
    console.warn(`Discord listGuildTextChannels failed: ${res.status} ${await res.text()}`);
    return [];
  }
  const all = (await res.json()) as DiscordChannel[];
  return all
    .filter((c) => c.type === 0 || c.type === 5)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}
