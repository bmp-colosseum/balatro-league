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
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Web admin dashboard.
  // PORT (Railway/Heroku/Fly all set this) wins; WEB_PORT is a manual override; 3000 is the dev default.
  PORT: z.coerce.number().int().positive().optional(),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_DASH_PASSWORD: z.string().optional(),
  // Discord OAuth (for player login + admin login)
  DISCORD_CLIENT_SECRET: z.string().optional(),
  // Defaults to http://localhost:<WEB_PORT>/auth/discord/callback if omitted.
  DISCORD_OAUTH_REDIRECT: z.string().url().optional(),
  // Random secret used to sign session cookies. Generate with `openssl rand -hex 32` for prod.
  SESSION_SECRET: z.string().default("change-this-in-prod-localhost-only"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
