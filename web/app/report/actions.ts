"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { disputeMatchFromWeb, type DisputeResultStr } from "@/lib/report";

// Server action backing the per-match Dispute button on /report's
// "Your recent matches" table. Mirrors submitProfileDispute but
// redirects back to /report instead of the profile.
export async function submitReportPageDispute(formData: FormData) {
  const session = await auth();
  const disputerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  if (!disputerDiscordId) redirect("/auth/signin?from=/report");

  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const proposedRaw = String(formData.get("proposed") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || null;

  if (!pairingId) {
    redirect(`/report?disputeErr=${encodeURIComponent("Missing match id")}`);
  }
  const proposed: DisputeResultStr =
    proposedRaw === "2-0" || proposedRaw === "1-1" || proposedRaw === "0-2"
      ? proposedRaw
      : "unsure";

  const r = await disputeMatchFromWeb(disputerDiscordId!, pairingId, proposed, reason);
  if (!r.ok) {
    redirect(`/report?disputeErr=${encodeURIComponent(r.reason)}`);
  }
  revalidatePath("/report");
  revalidatePath("/standings");
  revalidatePath("/me");
  redirect("/report?disputeOk=1");
}
