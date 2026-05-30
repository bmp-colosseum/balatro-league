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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
