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

// Page through every guild member (1000 at a time, ordered by id via `after`).
export async function fetchGuildMembers(): Promise<GuildMember[]> {
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
