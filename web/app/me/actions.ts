"use server";

// Server actions for /me. Pulled out of page.tsx so the page is a thin
// render. Each action validates auth itself — never trust the form.

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isDiscordIdBanned } from "@/lib/bans";

async function currentDiscordId(): Promise<string | null> {
  const session = await auth();
  return (session?.user as { discordId?: string } | undefined)?.discordId ?? null;
}

// Defense-in-depth for the custom display name (the real ping protection is the
// allowedMentions allowlist at the send layer, which also covers Discord-synced
// names this can't touch). Strip raw mention tokens + neutralize @everyone/@here
// so a name can't read as a mention anywhere, and cap the length.
function sanitizeDisplayName(raw: string): string {
  return raw
    .replace(/<(@[!&]?|#)\d+>/g, "") // raw <@id>/<@&id>/<#id> mentions — no legit use in a name
    .replace(/@(everyone|here)/gi, "$1") // drop the @ so it's inert text
    .slice(0, 40)
    .trim();
}

export async function setCustomNameAction(formData: FormData) {
  const discordId = await currentDiscordId();
  if (!discordId) return;
  const name = sanitizeDisplayName(String(formData.get("displayName") ?? ""));
  if (!name) return;
  await prisma.player.update({
    where: { discordId },
    data: { displayName: name, hasCustomDisplayName: true },
  });
  revalidatePath("/me");
}

export async function resetToDiscordNameAction() {
  const session = await auth();
  const discordId = (session?.user as { discordId?: string } | undefined)?.discordId ?? null;
  const discordName = (session?.user as { name?: string } | undefined)?.name;
  if (!discordId) return;
  await prisma.player.update({
    where: { discordId },
    data: {
      hasCustomDisplayName: false,
      ...(discordName ? { displayName: discordName } : {}),
    },
  });
  revalidatePath("/me");
}

// Opt-in timezone sharing. An empty value clears it (opt out). We validate the
// IANA zone server-side — constructing a DateTimeFormat with an unknown zone
// throws — so only a real zone is ever stored, and we keep only the zone tag,
// never any location data.
export async function setTimezoneAction(formData: FormData) {
  const discordId = await currentDiscordId();
  if (!discordId) return;
  const raw = String(formData.get("timezone") ?? "").trim();
  let timezone: string | null = null;
  if (raw) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw });
      timezone = raw;
    } catch {
      return; // unknown zone — ignore rather than store junk
    }
  }
  await prisma.player.update({ where: { discordId }, data: { timezone } });
  revalidatePath("/me");
}

// Opt-out toggle for the @username display. Default is shown (to verified server
// members); `show=0` hides it everywhere, `show=1` re-shows it.
export async function setShowUsernameAction(formData: FormData) {
  const discordId = await currentDiscordId();
  if (!discordId) return;
  const show = String(formData.get("show") ?? "") === "1";
  await prisma.player.update({ where: { discordId }, data: { showUsername: show } });
  revalidatePath("/me");
}

// Single season-reminders toggle (replaces the old auto-sign-up flag AND the
// separate notify subscribe/unsubscribe). ON = the bot DMs you a "you in?" when
// a new season's signups open; OFF = opted out. Keeps the SeasonInterest list
// and the per-player opt-out flag in sync so the reminder audience is correct
// whether or not you have a Player row yet.
export async function setSeasonRemindersAction(formData: FormData) {
  const discordId = await currentDiscordId();
  if (!discordId) return;
  const next = String(formData.get("next") ?? "") === "1";
  const player = await prisma.player.findUnique({ where: { discordId }, select: { id: true } });
  // Banned players can't opt IN to reminders (but can always opt out).
  if (next && (await isDiscordIdBanned(discordId))) {
    revalidatePath("/me");
    return;
  }
  if (next) {
    await prisma.seasonInterest.upsert({ where: { discordId }, create: { discordId }, update: {} });
    if (player) await prisma.player.update({ where: { id: player.id }, data: { signupReminderOptOut: false } });
  } else {
    await prisma.seasonInterest.deleteMany({ where: { discordId } });
    if (player) await prisma.player.update({ where: { id: player.id }, data: { signupReminderOptOut: true } });
  }
  if (player) revalidatePath(`/profile/${player.id}`);
  revalidatePath("/me");
}
