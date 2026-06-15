import { cache } from "react";
import { auth } from "@/auth";
import { getShowUsernames } from "@/lib/preferences";

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
