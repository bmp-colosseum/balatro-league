"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { reportSetFromWeb } from "@/lib/report";
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
  const { opponentId, result, games, valid } = parseReportForm(formData);
  if (!valid) redirect("/report?err=missing-fields");
  const r = await reportSetFromWeb(discordId!, opponentId, result, games);
  if (!r.ok) redirect(`/report?err=${encodeURIComponent(r.reason)}`);
  revalidatePath("/report");
  revalidatePath("/me");
  revalidatePath("/standings");
  redirect("/report?ok=1");
}
