// User UI preferences that stick across page loads via cookies. No DB
// table needed — these are per-browser, low-stakes, anonymous-friendly.
// Pages read with getShowBmpMmr(), the toggle component flips the cookie
// via a server action.

import { cookies } from "next/headers";

const SHOW_BMP_MMR_COOKIE = "show_bmp_mmr";
const SHOW_USERNAMES_COOKIE = "show_usernames";
const SHOW_DISCORD_IDS_COOKIE = "show_discord_ids";

const PREF_COOKIE_OPTS = {
  // 1 year — preference, not a session token.
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax",
  // Not HttpOnly because no security concern; visible to JS is fine.
  path: "/",
} as const;

export async function getShowBmpMmr(): Promise<boolean> {
  const store = await cookies();
  return store.get(SHOW_BMP_MMR_COOKIE)?.value === "1";
}

export async function setShowBmpMmr(show: boolean): Promise<void> {
  const store = await cookies();
  if (show) store.set(SHOW_BMP_MMR_COOKIE, "1", PREF_COOKIE_OPTS);
  else store.delete(SHOW_BMP_MMR_COOKIE);
}

// Reveal numeric Discord IDs in the <DiscordId> chip everywhere. This is just the
// per-browser cookie — the ADMIN gate lives in canSeeDiscordIds (usernames.ts),
// so a non-admin flipping this cookie has no effect.
export async function getShowDiscordIds(): Promise<boolean> {
  const store = await cookies();
  return store.get(SHOW_DISCORD_IDS_COOKIE)?.value === "1";
}

export async function setShowDiscordIds(show: boolean): Promise<void> {
  const store = await cookies();
  if (show) store.set(SHOW_DISCORD_IDS_COOKIE, "1", PREF_COOKIE_OPTS);
  else store.delete(SHOW_DISCORD_IDS_COOKIE);
}

// Public Discord @username display. DEFAULT ON — absence of the cookie means
// show, an explicit "0" hides. So "on" is the no-cookie state.
export async function getShowUsernames(): Promise<boolean> {
  const store = await cookies();
  return store.get(SHOW_USERNAMES_COOKIE)?.value !== "0";
}

export async function setShowUsernames(show: boolean): Promise<void> {
  const store = await cookies();
  if (show) store.delete(SHOW_USERNAMES_COOKIE); // absence = on (default)
  else store.set(SHOW_USERNAMES_COOKIE, "0", PREF_COOKIE_OPTS);
}
