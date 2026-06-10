"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { disputeMatchFromWeb, reportSetFromWeb, type DisputeResultStr, type ReportResultStr } from "@/lib/report";

// Server action backing the per-match Dispute button on /profile/[id].
// Only the player themself can dispute their own matches — the action
// validates that the session's discordId resolves to the disputer
// player record.
export async function submitProfileDispute(formData: FormData) {
  const session = await auth();
  const disputerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  if (!disputerDiscordId) redirect("/auth/signin");

  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const proposedRaw = String(formData.get("proposed") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const profileId = String(formData.get("profileId") ?? "").trim();

  if (!pairingId) {
    redirect(`/profile/${profileId}?disputeErr=${encodeURIComponent("Missing match id")}`);
  }
  const proposed: DisputeResultStr =
    proposedRaw === "2-0" || proposedRaw === "1-1" || proposedRaw === "0-2"
      ? proposedRaw
      : "unsure";

  const r = await disputeMatchFromWeb(disputerDiscordId!, pairingId, proposed, reason);
  if (!r.ok) {
    redirect(`/profile/${profileId}?disputeErr=${encodeURIComponent(r.reason)}`);
  }

  revalidatePath(`/profile/${profileId}`);
  revalidatePath("/standings");
  revalidatePath("/me");
  redirect(`/profile/${profileId}?disputeOk=1`);
}

// Report a match from the profile page's 'Report a match' dropdown
// (only rendered when isOwnProfile is true). Same backend as the /me
// dropdown, redirect lands you back on your profile.
export async function reportFromProfileAction(formData: FormData) {
  const session = await auth();
  const discordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  const profileId = String(formData.get("profileId") ?? "");
  if (!discordId) redirect(`/profile/${profileId}?reportErr=not-logged-in`);
  const opponentId = String(formData.get("opponentId") ?? "");
  const result = String(formData.get("result") ?? "") as ReportResultStr;
  if (!opponentId || !["2-0", "1-1", "0-2"].includes(result)) {
    redirect(`/profile/${profileId}?reportErr=missing-fields`);
  }
  const r = await reportSetFromWeb(discordId!, opponentId, result);
  if (!r.ok) redirect(`/profile/${profileId}?reportErr=${encodeURIComponent(r.reason)}`);
  revalidatePath(`/profile/${profileId}`);
  revalidatePath("/standings");
  revalidatePath("/me");
  redirect(`/profile/${profileId}?reportOk=1`);
}
