// Single source of truth for the admin-configurable Discord server invite URL
// (LeagueConfig key "discord_server_invite_url") -- shared by /join
// (lib/loaders/join.ts) and the site-wide footer (components/SiteFooter.tsx,
// wired in app/layout.tsx) so both read the exact same config value instead of
// each running their own copy of this query.

import { prisma } from "@/lib/prisma";

export async function loadDiscordInviteUrl(): Promise<string | null> {
  const row = await prisma.leagueConfig.findUnique({
    where: { key: "discord_server_invite_url" },
    select: { value: true },
  });
  return row?.value ?? null;
}
