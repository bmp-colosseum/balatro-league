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
  // Channel ID for DevOps alerts (queue stalls, rate-limit floods, infra
  // health). Infra alerts go to the people who can debug them. If unset,
  // the bot auto-creates a '🔧 devops' channel restricted to the DEVOPS
  // role on startup.
  DEVOPS_CHANNEL_ID: z.string().optional(),
  // Channel ID for league-wide announcements (scheduled season starts,
  // season recaps, league news). Public — every member sees and reads,
  // only the bot posts. Auto-created as '#announcements' under the league
  // category on startup if unset.
  ANNOUNCEMENTS_CHANNEL_ID: z.string().optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Base URL of the web dashboard THIS bot instance should link to. Defaults
  // to prod; the TEST bot service sets this to its own web URL so links it
  // posts in the test Discord (division schedules, /league info, disputes)
  // point at the test site instead of prod. No trailing slash needed.
  WEB_BASE_URL: z.string().url().default("https://www.balatroleague.com"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
