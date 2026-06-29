// Bulk username → numeric-id resolver: reads the Tour Discord guild's MEMBER LIST.
// Signups only carry a Discord @username (a string), not the numeric id Player.discordId
// needs. Everyone who signed up was required to be in the Tour server, so the guild
// member list is the complete username→id map. Needs a bot token with the GUILD
// MEMBERS privileged intent and the bot present in the guild. Optional — no-ops (returns
// []) when unconfigured, so the rest of identity resolution still works off the league DB.
const API = "https://discord.com/api/v10";

export const discordGuildConfigured = () => !!(process.env.TOUR_DISCORD_TOKEN && process.env.TOUR_GUILD_ID);

export interface GuildMember {
  id: string; // numeric Discord id
  names: string[]; // username, global display name, server nickname — any may match a sheet name
}

// IN-MEMORY ONLY cache (process-local, short TTL). The guild roster is used
// TRANSIENTLY to resolve usernames → ids during identity linking; it is never
// written to the database and never exposed. Only the ids of players an admin
// actually approves get persisted (on those Player rows). Clears on restart.
let cache: { at: number; members: GuildMember[] } | null = null;
const TTL_MS = 10 * 60 * 1000;

// Name → numeric id rows from the live guild roster (each username/global/nick),
// for transient identity resolution. [] when the bot isn't configured.
export async function guildNameRows(): Promise<{ discordId: string; name: string }[]> {
  const members = await fetchGuildMembers();
  const out: { discordId: string; name: string }[] = [];
  for (const m of members) for (const name of m.names) out.push({ discordId: m.id, name });
  return out;
}

// Page through every guild member (1000 at a time, ordered by id via `after`).
// Cached in memory only.
export async function fetchGuildMembers(): Promise<GuildMember[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.members;
  const token = process.env.TOUR_DISCORD_TOKEN;
  const guild = process.env.TOUR_GUILD_ID;
  if (!token || !guild) return [];

  const out: GuildMember[] = [];
  let after = "0";
  for (let page = 0; page < 100; page++) {
    // 100-page cap = 100k members, a hard backstop against a runaway loop.
    const res = await fetch(`${API}/guilds/${guild}/members?limit=1000&after=${after}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        res.status === 401 ? "Discord rejected the bot token (401)."
        : res.status === 403 ? "Bot lacks access — enable the Server Members Intent and make sure the bot is in the guild (403)."
        : `Discord API ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const members = (await res.json()) as { user?: { id: string; username?: string; global_name?: string | null }; nick?: string | null }[];
    if (!members.length) break;
    for (const m of members) {
      if (!m.user?.id) continue;
      const names = [m.user.username, m.user.global_name, m.nick].filter((n): n is string => !!n && n.trim().length > 0);
      out.push({ id: m.user.id, names });
      after = m.user.id;
    }
    if (members.length < 1000) break;
  }
  cache = { at: Date.now(), members: out };
  return out;
}

// Cheap connectivity/permission check for diagnostics (never throws).
export async function discordGuildReachable(): Promise<boolean> {
  const token = process.env.TOUR_DISCORD_TOKEN;
  const guild = process.env.TOUR_GUILD_ID;
  if (!token || !guild) return false;
  try {
    const res = await fetch(`${API}/guilds/${guild}/members?limit=1`, { headers: { Authorization: `Bot ${token}` } });
    return res.ok;
  } catch {
    return false;
  }
}
