"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

async function currentDiscordIdOrRedirect(): Promise<string> {
  const session = await auth();
  const discordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  if (!discordId) redirect("/auth/signin?callbackUrl=%2Fjoin");
  return discordId;
}

// Opt in to "notify me when next season opens". Idempotent — the
// SeasonInterest row is keyed by discordId, so repeated submits don't
// create dupes.
export async function subscribeFromJoinAction() {
  const discordId = await currentDiscordIdOrRedirect();
  await prisma.seasonInterest.upsert({
    where: { discordId },
    create: { discordId },
    update: {},
  });
  revalidatePath("/join");
}

export async function unsubscribeFromJoinAction() {
  const discordId = await currentDiscordIdOrRedirect();
  await prisma.seasonInterest.deleteMany({ where: { discordId } });
  revalidatePath("/join");
}

// Sign up for the currently-open signup round directly from the website.
// Mirrors the Discord button: write a Signup row keyed by (roundId,
// discordId). Display name defaults to whatever Discord gave us; admin
// can override later from the build page.
export async function signupFromJoinAction(formData: FormData) {
  const discordId = await currentDiscordIdOrRedirect();
  const roundId = String(formData.get("roundId") ?? "").trim();
  if (!roundId) redirect("/join?err=missing-round");

  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round) redirect("/join?err=round-not-found");
  if (round!.status !== "OPEN") redirect("/join?err=signups-closed");

  const session = await auth();
  const displayName =
    (session?.user as { name?: string | null } | undefined)?.name?.trim() || discordId;

  await prisma.signup.upsert({
    where: { roundId_discordId: { roundId, discordId } },
    // Withdrawn signups get re-activated on re-signup, mirroring the
    // Discord button handler's behavior. Display name updates each time
    // so a Discord username change flows through if the player re-signs.
    update: { withdrawn: false, displayName },
    create: { roundId, discordId, displayName },
  });
  // The Discord embed reads count from the DB on every button click,
  // so it'll pick up the new signup the next time someone interacts.
  // For immediate refresh we'd need to call refreshSignupMessage from
  // the bot side, which the web service can't do directly — leaving
  // the embed slightly stale until the next click is acceptable.
  revalidatePath("/join");
  redirect("/join?ok=signed-up");
}

export async function withdrawFromJoinAction(formData: FormData) {
  const discordId = await currentDiscordIdOrRedirect();
  const roundId = String(formData.get("roundId") ?? "").trim();
  if (!roundId) return;
  await prisma.signup.updateMany({
    where: { roundId, discordId },
    data: { withdrawn: true },
  });
  revalidatePath("/join");
  redirect("/join?ok=withdrew");
}
