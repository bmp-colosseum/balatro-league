// Sync the FULL Discord guild member roster into the GuildMember table
// (username / globalName / nickname -> numeric id). Its only purpose is
// username->id resolution for tools that SHARE this server (the Team Tour app reads
// GuildMember read-only): Discord has no public username->id lookup, so the guild
// roster is the only source. Mirrors display-name-refresh, but bulk-fetches every
// member via the privileged GuildMembers intent instead of per-known-player.
//
// Gated by env.GUILD_MEMBER_SYNC so it's inert until the intent is enabled. Runs from
// a daily cron AND an /admin sync-members command.

import { GatewayIntentBits } from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { env } from "./env.js";

// In-process lock: bulk member fetch uses gateway opcode 8, which is rate limited.
// The boot trigger, daily cron, and /admin command all call this, so serialize them —
// overlapping fetches trip "Request with opcode 8 was rate limited".
let syncing = false;

export async function runGuildMemberSync(): Promise<{ synced: number; removed: number; skipped?: boolean }> {
  if (syncing) {
    console.warn("[sync.guild-members] a sync is already running — skipping this overlap");
    return { synced: 0, removed: 0, skipped: true };
  }
  const guildId = env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn("[sync.guild-members] no DISCORD_GUILD_ID — skipping");
    return { synced: 0, removed: 0 };
  }
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[sync.guild-members] Discord client not ready — skipping");
    return { synced: 0, removed: 0 };
  }
  // Auto-skip (no env flag) when the privileged intent isn't actually granted — the
  // boot ladder drops it if the portal toggle is off, and bulk-fetching without it
  // would just hang. The sync starts working on its own once the intent is enabled.
  if (!client.options.intents.has(GatewayIntentBits.GuildMembers)) {
    console.warn("[sync.guild-members] GuildMembers intent not active — enable Server Members in the portal; skipping");
    return { synced: 0, removed: 0 };
  }
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.warn(`[sync.guild-members] couldn't fetch guild ${guildId}`);
    return { synced: 0, removed: 0 };
  }

  syncing = true;
  try {
    // One bulk fetch of every member (needs the GuildMembers privileged intent).
    const members = await guild.members.fetch();
    const seen = new Set<string>();
    let synced = 0;
    for (const m of members.values()) {
      seen.add(m.id);
      const data = {
        username: m.user.username ?? null,
        globalName: m.user.globalName ?? null,
        nickname: m.nickname ?? null,
      };
      await prisma.guildMember.upsert({
        where: { discordId: m.id },
        create: { discordId: m.id, ...data },
        update: data,
      });
      synced++;
    }

    // Prune rows for anyone who left, so the roster stays current.
    const existing = await prisma.guildMember.findMany({ select: { discordId: true } });
    const stale = existing.filter((e) => !seen.has(e.discordId)).map((e) => e.discordId);
    if (stale.length) await prisma.guildMember.deleteMany({ where: { discordId: { in: stale } } });

    console.log(`[sync.guild-members] synced ${synced}, removed ${stale.length}`);
    return { synced, removed: stale.length };
  } finally {
    syncing = false;
  }
}
