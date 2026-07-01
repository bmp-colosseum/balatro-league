// Discord ID visibility — mirrors the league's convention: raw Discord IDs are shown only
// to admins/TOs, behind a cookie toggle so they can "limit" the display. Non-admins never
// see IDs (data-minimized). Default is ON for admins (absence of the cookie = show).
import { cookies } from "next/headers";
import { cache } from "react";
import { isAdmin } from "./auth";

const COOKIE = "tour_show_discord_ids";
const MAX_AGE = 60 * 60 * 24 * 365;

// Cached per request so a page full of <PlayerName>s resolves the gate once.
export const canSeeDiscordIds = cache(async (): Promise<boolean> => {
  if (!(await isAdmin())) return false;
  const store = await cookies();
  return store.get(COOKIE)?.value !== "0";
});

// The raw cookie state (admin preference), independent of the admin check — for the toggle UI.
export async function discordIdsShown(): Promise<boolean> {
  const store = await cookies();
  return store.get(COOKIE)?.value !== "0";
}

// Set the admin's preference (call only from a server action / route handler).
export async function setShowDiscordIds(show: boolean): Promise<void> {
  const store = await cookies();
  if (show) store.delete(COOKIE);
  else store.set(COOKIE, "0", { path: "/", maxAge: MAX_AGE });
}

// A real, showable Discord id (not a legacy placeholder).
export const isRealDiscordId = (id: string | null | undefined): id is string => !!id && !id.startsWith("legacy:");
