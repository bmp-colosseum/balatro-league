import { cache } from "react";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isAdminUser } from "@/lib/admin";
import { getShowUsernames, getShowDiscordIds } from "@/lib/preferences";

// The SUBJECT-side half of the username gate: discordIds whose owner opted OUT
// of showing their @username (Player.showUsername = false). AND'd with the
// viewer-side canSeeUsernames below, so BOTH the person and the viewer have to
// allow it. cache() memoizes per request, so rendering 50 names is one query;
// the set is usually tiny (default is "shown").
export const getHiddenUsernameIds = cache(async (): Promise<Set<string>> => {
  const rows = await prisma.player.findMany({
    where: { showUsername: false },
    select: { discordId: true },
  });
  return new Set(rows.map((r) => r.discordId));
});

// Whether the CURRENT viewer may see other players' Discord @usernames. Gate:
//   1. they're a verified member of the server (checked at login → session), AND
//   2. they have the ⚙️ "Show Discord usernames" toggle on (per-browser cookie).
// Non-members / logged-out visitors get `false`, so the @username is never even
// rendered into the HTML for them (not just CSS-hidden). cache() memoizes per
// request, so rendering it next to 50 names costs one auth lookup.
export const canSeeUsernames = cache(async (): Promise<boolean> => {
  const session = await auth();
  const inGuild = (session?.user as { inGuild?: boolean } | undefined)?.inGuild === true;
  if (!inGuild) return false;
  return getShowUsernames();
});

// Whether the viewer may see numeric Discord IDs in the <DiscordId> chip:
// ADMINS ONLY, and only when they've flipped the admin "Show Discord IDs" toggle.
// Non-admins always get false regardless of the cookie. cache() → one check/request.
export const canSeeDiscordIds = cache(async (): Promise<boolean> => {
  if (!(await isAdminUser())) return false;
  return getShowDiscordIds();
});
