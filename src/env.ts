import { config } from "dotenv";
import { z } from "zod";

config();

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  DISCORD_GUILD_ID: z.string().optional(),
  LEAGUE_ADMIN_ROLE_ID: z.string().optional(),
  LEAGUE_OWNER_DISCORD_ID: z.string().optional(),
  RESULTS_CHANNEL_ID: z.string().optional(),
  // Optional: post auto-announces via a webhook instead of the bot's REST
  // channel.send. Webhooks don't count against the bot's global 50/sec
  // budget — keeps the announce path out of contention with bursty admin
  // operations (bootstrap, DM blast). Create one via Channel Settings →
  // Integrations → Webhooks → New Webhook → Copy Webhook URL.
  RESULTS_WEBHOOK_URL: z.string().url().optional(),
  // Channel ID where match-flow commands (/start-match, /challenge, /report,
  // /cancel-match) are allowed in addition to the per-division channels.
  // Players use this channel for everything that isn't tied to a specific
  // division (mostly /challenge for casual matches). Optional — if unset,
  // match-flow commands only work in division channels.
  BOT_COMMANDS_CHANNEL_ID: z.string().optional(),
  // Channel ID for daily league backups (JSON snapshot attachment).
  // Should be admin-private — backup includes seasons/divisions/pairings
  // which is sensitive league config. If unset, bot auto-creates a
  // '📦 league-backups' channel restricted to staff roles on startup.
  BACKUP_CHANNEL_ID: z.string().optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
