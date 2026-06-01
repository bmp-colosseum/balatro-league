// Resolves the DevOps alert channel id. Mirrors backup-channel.ts:
//   env.DEVOPS_CHANNEL_ID → LeagueConfig.DevopsChannelId → null
//
// Null means "log to console only" — the alert cron still runs but
// won't post anywhere. That keeps the bot functional even if the
// admin never bootstraps a devops channel.
//
// ensureDevopsChannel runs once at startup and auto-creates a private
// '🔧 devops' channel restricted to DEVOPS role bindings. Bot itself
// is granted explicit access via permission overwrite — without it,
// the @everyone deny applies to the bot too and posts would fail.

import { ChannelType } from "discord.js";
import { env } from "./env.js";
import { createGuildTextChannel, ensureGuildCategory } from "./discord-helpers.js";
import { getConfig, setConfig, LeagueConfigKey } from "./league-config.js";
import { prisma } from "./db.js";

export async function resolveDevopsChannelId(): Promise<string | null> {
  if (env.DEVOPS_CHANNEL_ID) return env.DEVOPS_CHANNEL_ID;
  return getConfig(LeagueConfigKey.DevopsChannelId);
}

export async function ensureDevopsChannel(): Promise<void> {
  if (env.DEVOPS_CHANNEL_ID) return;
  const existing = await getConfig(LeagueConfigKey.DevopsChannelId);
  if (existing) return;
  if (!env.DISCORD_GUILD_ID) {
    console.warn("[devops-channel] DISCORD_GUILD_ID not set; skipping auto-create");
    return;
  }
  // Restrict view + send to DEVOPS role bindings. If none exist yet
  // (fresh install / pre-bootstrap), the channel is created with
  // @everyone-deny anyway — admin can bind a role later via
  // /league set-role and the channel remains the canonical alert
  // destination.
  const devopsBindings = await prisma.roleBinding.findMany({
    where: { tier: "DEVOPS" },
  });
  const devopsRoleIds = devopsBindings.map((b) => b.discordRoleId);
  const category = await ensureGuildCategory(env.DISCORD_GUILD_ID, "🃏 Balatro League");
  const channel = await createGuildTextChannel(env.DISCORD_GUILD_ID, "devops", {
    parentId: category?.id,
    topic: "🔧 Infra alerts: queue stalls, rate-limit floods, anything tech. DevOps-only.",
    visibleToRoleIds: devopsRoleIds,
  });
  if (!channel) {
    console.warn("[devops-channel] auto-create failed; admin can set DEVOPS_CHANNEL_ID env var");
    return;
  }
  await setConfig(LeagueConfigKey.DevopsChannelId, channel.id, "bot-startup-auto-create");
  console.log(`[devops-channel] auto-created channel ${channel.id} and stored in LeagueConfig`);
  void ChannelType;
}
