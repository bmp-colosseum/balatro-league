"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { reportSetFromWeb } from "@/lib/report";
import { parseReportForm } from "@/lib/report-form";

// Report a match from the profile page's 'Report a match' dropdown
// (only rendered when isOwnProfile is true). Same backend as the /me
// dropdown, redirect lands you back on your profile.
export async function reportFromProfileAction(formData: FormData) {
  const session = await auth();
  const discordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  const profileId = String(formData.get("profileId") ?? "");
  if (!discordId) redirect(`/profile/${profileId}?reportErr=not-logged-in`);
  const { opponentId, result, games, valid } = parseReportForm(formData);
  if (!valid) redirect(`/profile/${profileId}?reportErr=missing-fields`);
  const r = await reportSetFromWeb(discordId!, opponentId, result, games);
  if (!r.ok) redirect(`/profile/${profileId}?reportErr=${encodeURIComponent(r.reason)}`);
  revalidatePath(`/profile/${profileId}`);
  revalidatePath("/standings");
  revalidatePath("/me");
  redirect(`/profile/${profileId}?reportOk=1`);
}
