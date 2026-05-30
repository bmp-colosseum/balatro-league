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

export interface MessageEmbed {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  timestamp?: string;
}

// Post a message to a Discord channel. Embeds are an array of objects.
export async function postChannelMessage(
  channelId: string,
  payload: { content?: string; embeds?: MessageEmbed[] },
): Promise<void> {
  const res = await fetch(`${BASE_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: botAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn(`Discord postChannelMessage failed: ${res.status} ${await res.text()}`);
  }
}
