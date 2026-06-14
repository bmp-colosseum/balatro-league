import { prisma } from "@/lib/prisma";

// Global admin display preference: whether to show Discord IDs in admin
// player/signup lists (seasons roster, build roster, division detail). Stored
// in LeagueConfig.admin_show_discord_ids and toggled from /admin/config →
// Display. Defaults to ON when unset (only an explicit "false" hides them), so
// IDs stay visible out of the box — matching the rosters' prior always-on
// behavior.
export async function getShowDiscordIds(): Promise<boolean> {
  const row = await prisma.leagueConfig.findUnique({ where: { key: "admin_show_discord_ids" } });
  return row?.value !== "false";
}
