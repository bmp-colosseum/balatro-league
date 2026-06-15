"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  disputeMatchFromWeb,
  reportSetFromWeb,
  type DisputeResultStr,
} from "@/lib/report";
import { parseReportForm } from "@/lib/report-form";

async function currentDiscordId(): Promise<string | null> {
  const session = await auth();
  return (session?.user as { discordId?: string } | undefined)?.discordId ?? null;
}

// Submit a new report from /report. Mirrors /me's reportFromMePageAction
// but redirects back to /report. Both ultimately funnel through
// reportSetFromWeb so the rules are identical.
export async function submitReportFromReportPage(formData: FormData) {
  const discordId = await currentDiscordId();
  if (!discordId) redirect("/report?err=not-logged-in");
  const { opponentId, result, deck, stake, lives, valid } = parseReportForm(formData);
  if (!valid) redirect("/report?err=missing-fields");
  const r = await reportSetFromWeb(discordId!, opponentId, result, { deck, stake }, lives);
  if (!r.ok) redirect(`/report?err=${encodeURIComponent(r.reason)}`);
  revalidatePath("/report");
  revalidatePath("/me");
  revalidatePath("/standings");
  redirect("/report?ok=1");
}

// Server action backing the per-match Dispute button on /report's
// "Your recent matches" table. Mirrors submitProfileDispute but
// redirects back to /report instead of the profile.
export async function submitReportPageDispute(formData: FormData) {
  const disputerDiscordId = await currentDiscordId();
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
