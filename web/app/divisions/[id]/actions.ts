"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { reportSetFromWeb, type ReportResultStr } from "@/lib/report";

// Report a match from the public division page. Same backend as /me
// and /profile dropdowns; redirect lands you back on the division.
export async function reportFromDivisionAction(formData: FormData) {
  const session = await auth();
  const discordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  const divisionId = String(formData.get("divisionId") ?? "");
  if (!discordId) redirect(`/divisions/${divisionId}?reportErr=not-logged-in`);
  const opponentId = String(formData.get("opponentId") ?? "");
  const result = String(formData.get("result") ?? "") as ReportResultStr;
  if (!opponentId || !["2-0", "1-1", "0-2"].includes(result)) {
    redirect(`/divisions/${divisionId}?reportErr=missing-fields`);
  }
  const r = await reportSetFromWeb(discordId!, opponentId, result);
  if (!r.ok) redirect(`/divisions/${divisionId}?reportErr=${encodeURIComponent(r.reason)}`);
  revalidatePath(`/divisions/${divisionId}`);
  revalidatePath("/standings");
  revalidatePath("/me");
  redirect(`/divisions/${divisionId}?reportOk=1`);
}
