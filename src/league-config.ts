// Tiny KV helpers for LeagueConfig. All values are strings; serialize
// JSON yourself if you need structure.

import { prisma } from "./db.js";

export const LeagueConfigKey = {
  ResultsWebhookUrl: "results_webhook_url",
  // Channel where match-flow commands (/start-match, /challenge, /report)
  // are allowed in addition to division channels. Resolved as
  // env.BOT_COMMANDS_CHANNEL_ID → LeagueConfig.BotCommandsChannelId →
  // auto-created on bot startup if neither is set.
  BotCommandsChannelId: "bot_commands_channel_id",
  // Channel where daily league backup attachments are posted. Should be
  // staff-only since the JSON includes sensitive league config. Same
  // env → LeagueConfig → auto-create resolution as BotCommandsChannelId.
  BackupChannelId: "backup_channel_id",
} as const;

export type LeagueConfigKey = (typeof LeagueConfigKey)[keyof typeof LeagueConfigKey];

export async function getConfig(key: LeagueConfigKey): Promise<string | null> {
  const row = await prisma.leagueConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setConfig(key: LeagueConfigKey, value: string, updatedBy: string): Promise<void> {
  await prisma.leagueConfig.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
}

export async function clearConfig(key: LeagueConfigKey): Promise<void> {
  await prisma.leagueConfig.deleteMany({ where: { key } });
}
