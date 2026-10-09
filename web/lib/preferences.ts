// User UI preferences that stick across page loads via cookies. No DB
// table needed — these are per-browser, low-stakes, anonymous-friendly.
// Pages read with getShowBmpMmr(), the toggle component flips the cookie
// via a server action.

import { cookies } from "next/headers";

const SHOW_BMP_MMR_COOKIE = "show_bmp_mmr";
const SHOW_USERNAMES_COOKIE = "show_usernames";
const SHOW_DISCORD_IDS_COOKIE = "show_discord_ids";
// "Card Table" v2 preview flag -- see web/app/admin/ui-preview-actions.ts for
// the admin-only toggle and web/app/layout.tsx for where it's read.
const UI_PREVIEW_COOKIE = "league-ui";
const UI_PREVIEW_V2_VALUE = "v2";

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

// Preview the v2 "Card Table" redesign. Admin-gated at the action layer
// (web/app/admin/ui-preview-actions.ts), not here -- a stray cookie on a
// non-admin browser is harmless, it just renders the v2 look for them too.
export async function getUiPreviewV2(): Promise<boolean> {
  const store = await cookies();
  return store.get(UI_PREVIEW_COOKIE)?.value === UI_PREVIEW_V2_VALUE;
}

export async function setUiPreviewV2(on: boolean): Promise<void> {
  const store = await cookies();
  if (on) store.set(UI_PREVIEW_COOKIE, UI_PREVIEW_V2_VALUE, PREF_COOKIE_OPTS);
  else store.delete(UI_PREVIEW_COOKIE);
}
