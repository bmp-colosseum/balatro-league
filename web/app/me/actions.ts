"use server";

// Server actions for /me. Pulled out of page.tsx so the page is a thin
// render. Each action validates auth itself — never trust the form.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { reportSetFromWeb, type ReportResultStr } from "@/lib/report";

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

export async function reportFromMePageAction(formData: FormData) {
  const discordId = await currentDiscordId();
  if (!discordId) redirect("/me?err=not-logged-in");
  const opponentId = String(formData.get("opponentId") ?? "");
  const result = String(formData.get("result") ?? "") as ReportResultStr;
  if (!opponentId || !["2-0", "1-1", "0-2"].includes(result)) {
    redirect("/me?err=missing-fields");
  }
  const r = await reportSetFromWeb(discordId!, opponentId, result);
  if (!r.ok) redirect(`/me?err=${encodeURIComponent(r.reason)}`);
  revalidatePath("/me");
  revalidatePath("/standings");
  redirect("/me?ok=1");
}
