// Resolves the league backup channel id with admin-override precedence:
//   env.BACKUP_CHANNEL_ID → LeagueConfig.BackupChannelId → null
//
// ensureBackupChannel runs once at bot startup and, if neither source has
// a value, creates a private '📦 league-backups' channel restricted to
// admin + mod roles (no @everyone access) and stores its id in
// LeagueConfig so it survives restarts.
//
// Backups contain full season + pairing data which is sensitive league
// config, so the auto-created channel deliberately denies @everyone
// ViewChannel. Admin can override via env var to use any pinned channel.

import { ChannelType } from "discord.js";
import { env } from "./env.js";
import { createGuildTextChannel, ensureGuildCategory } from "./discord-helpers.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { prisma } from "./db.js";

export async function resolveBackupChannelId(): Promise<string | null> {
  if (env.BACKUP_CHANNEL_ID) return env.BACKUP_CHANNEL_ID;
  return getConfig(LeagueConfigKey.BackupChannelId);
}

export async function ensureBackupChannel(): Promise<void> {
  if (env.BACKUP_CHANNEL_ID) {
    // Admin pinned a specific channel — respect that, don't auto-create.
    return;
  }
  const existing = await getConfig(LeagueConfigKey.BackupChannelId);
  if (existing) return;
  if (!env.DISCORD_GUILD_ID) {
    console.warn("[backup-channel] DISCORD_GUILD_ID not set; skipping auto-create");
    return;
  }
  // Restrict view + send to ADMIN / MOD role bindings. If no role
  // bindings exist yet (fresh install), the channel is created with
  // only @everyone-deny — bot itself is auto-allowed via the helper.
  // Admin can then bind roles via /league set-role and the channel
  // remains the canonical backup destination.
  const staffBindings = await prisma.roleBinding.findMany({
    where: { tier: { in: ["ADMIN", "MOD"] } },
  });
  const staffRoleIds = staffBindings.map((b) => b.discordRoleId);
  const category = await ensureGuildCategory(env.DISCORD_GUILD_ID, "🃏 Balatro League");
  const channel = await createGuildTextChannel(env.DISCORD_GUILD_ID, "league-backups", {
    parentId: category?.id,
    topic: "📦 Daily JSON snapshots of restorable league state. Staff-only.",
    visibleToRoleIds: staffRoleIds,
  });
  if (!channel) {
    console.warn("[backup-channel] auto-create failed; admin can set BACKUP_CHANNEL_ID env var");
    return;
  }
  await setConfig(LeagueConfigKey.BackupChannelId, channel.id, "bot-startup-auto-create");
  console.log(`[backup-channel] auto-created channel ${channel.id} and stored in LeagueConfig`);
  void ChannelType;
}
