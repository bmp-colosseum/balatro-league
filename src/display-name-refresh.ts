// Sync every player's league display name + @username from their CURRENT
// Discord server identity. Pulled out of queue.ts: the refresh.display-names
// daily cron AND /admin sync-names call this, but it's pure Discord-fetch + DB
// work with no queue concerns.

import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { isDiscordSnowflake } from "./discord-helpers.js";
import { env } from "./env.js";

// Pull each player's current SERVER (guild) display name and store it as
// their league display name, so the league reflects nicknames and tracks
// changes. Individual member fetches (no privileged GuildMembers intent
// needed). Skips players who set a custom name, and silently skips anyone
// who left the guild / can't be fetched.
export async function runDisplayNameRefresh(): Promise<{ updated: number; checked: number }> {
  const guildId = env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("[refresh.display-names] no DISCORD_GUILD_ID — skipping");
    return { updated: 0, checked: 0 };
  }
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[refresh.display-names] Discord client not ready — skipping");
    return { updated: 0, checked: 0 };
  }
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.warn(`[refresh.display-names] couldn't fetch guild ${guildId}`);
    return { updated: 0, checked: 0 };
  }
  // Fetch ALL players: username syncs for everyone (it's the Discord handle,
  // independent of a custom display name), while displayName only syncs for
  // players who haven't set their own (hasCustomDisplayName=false).
  const players = await prisma.player.findMany({
    select: { id: true, discordId: true, displayName: true, username: true, hasCustomDisplayName: true },
  });
  let updated = 0;
  let unresolved = 0; // couldn't be fetched from Discord at all (logged)
  for (const p of players) {
    // Each player is isolated in try/catch so one transient fetch/DB error
    // can't abort the loop and strand every player after it. discord.js's REST
    // client already queues + retries 429s, so rate limits slow this down but
    // don't drop anyone — a player only ends up here on a hard, repeated error.
    try {
      if (!isDiscordSnowflake(p.discordId)) continue; // seeded/mock id — skip the API call
      const member = await guild.members.fetch(p.discordId).catch(() => null);
      const data: { displayName?: string; username?: string } = {};
      if (member) {
        // Current member: sync the league display name (global → nick → @username,
        // matching guildDisplayName()) plus the @username.
        const name = member.user.globalName ?? member.nickname ?? member.user.username;
        if (!p.hasCustomDisplayName && name && name !== p.displayName) data.displayName = name;
        if (member.user.username !== p.username) data.username = member.user.username;
      } else {
        // Left the guild — we can't read a nickname, but the @username is a global
        // identity, so fetch the User directly so ex-members still get their tag.
        const user = await client.users.fetch(p.discordId).catch(() => null);
        if (user) {
          if (user.username !== p.username) data.username = user.username;
        } else if (!p.username) {
          unresolved++;
          console.warn(`[refresh.display-names] couldn't resolve ${p.discordId} (${p.displayName}) — no member + user.fetch failed`);
        }
      }
      if (Object.keys(data).length > 0) {
        await prisma.player.update({ where: { id: p.id }, data });
        updated++;
      }
    } catch (err) {
      unresolved++;
      console.warn(`[refresh.display-names] ${p.discordId} (${p.displayName}) failed: ${(err as Error).message}`);
    }
  }
  console.log(`[refresh.display-names] updated ${updated}/${players.length} (${unresolved} unresolved)`);
  return { updated, checked: players.length };
}
