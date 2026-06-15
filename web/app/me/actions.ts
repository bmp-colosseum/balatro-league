"use server";

// Server actions for /me. Pulled out of page.tsx so the page is a thin
// render. Each action validates auth itself — never trust the form.

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

async function currentDiscordId(): Promise<string | null> {
  const session = await auth();
  return (session?.user as { discordId?: string } | undefined)?.discordId ?? null;
}

export async function setCustomNameAction(formData: FormData) {
  const discordId = await currentDiscordId();
  if (!discordId) return;
  const name = String(formData.get("displayName") ?? "").trim();
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

// Toggle auto-sign-up: when ON, the player is automatically entered into the
// next signup round the moment it opens (they can still withdraw). Lives on
// the profile owner settings.
export async function setAutoSignupAction(formData: FormData) {
  const session = await auth();
  const u = session?.user as { discordId?: string; name?: string } | undefined;
  const discordId = u?.discordId ?? null;
  if (!discordId) return;
  const next = String(formData.get("next") ?? "") === "1";
  if (next) {
    // Enabling auto-sign-up means "enter me as a player when the next round
    // opens" — so create the Player record if the user doesn't have one yet.
    // This lets admins / not-yet-joined users opt in directly (previously a
    // silent no-op because the flag lives on Player).
    const player = await prisma.player.upsert({
      where: { discordId },
      create: { discordId, displayName: u?.name?.trim() || "Player", autoSignup: true },
      update: { autoSignup: true },
    });
    revalidatePath(`/profile/${player.id}`);
  } else {
    // Disabling only matters if a Player exists.
    const player = await prisma.player.findUnique({ where: { discordId }, select: { id: true } });
    if (!player) return;
    await prisma.player.update({ where: { id: player.id }, data: { autoSignup: false } });
    revalidatePath(`/profile/${player.id}`);
  }
  revalidatePath("/me");
}

export async function subscribeNextSeasonAction() {
  const discordId = await currentDiscordId();
  if (!discordId) return;
  await prisma.seasonInterest.upsert({
    where: { discordId },
    create: { discordId },
    update: {},
  });
  revalidatePath("/me");
}

export async function unsubscribeNextSeasonAction() {
  const discordId = await currentDiscordId();
  if (!discordId) return;
  await prisma.seasonInterest.deleteMany({ where: { discordId } });
  revalidatePath("/me");
}
