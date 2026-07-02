"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth";
import { addSignup, withdrawSignup, setSignupStatus } from "@/lib/services/signups";
import { fetchBmpStats } from "@/lib/balatromp";
import type { ActionResult } from "@/lib/action-result";

// Self-serve signup. The identity is the AUTHENTICATED viewer's discordId — never a
// form field — so a player can only ever sign up / edit / withdraw themselves.
// BMP rank/MMR is auto-pulled by discordId (best-effort; failure never blocks signup).
export async function submitSignupAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const v = await getViewer();
  if (!v.discordId) return { ok: false, message: "Sign in with Discord first." };
  const season = String(formData.get("season") ?? "");
  if (!season) return { ok: false, message: "No open season." };
  const s = (k: string) => String(formData.get(k) ?? "");
  const on = (k: string) => formData.get(k) === "on";
  try {
    const bmp = await fetchBmpStats(v.discordId);
    const activityRaw = Number(formData.get("discordActivity"));
    const row = await addSignup(season, {
      discordId: v.discordId,
      displayName: v.name ?? undefined,
      timezone: s("timezone"),
      availability: s("availability"),
      scheduleAgency: s("scheduleAgency"),
      playFrequency: s("playFrequency"),
      teamActivity: s("teamActivity"),
      coachWilling: on("coachWilling"),
      coachWanted: on("coachWanted"),
      coachingNote: s("coachingNote"),
      captainInterest: s("captainInterest"),
      helperInterest: on("helperInterest"),
      englishOk: on("englishOk"),
      discordActivity: Number.isFinite(activityRaw) && activityRaw >= 1 && activityRaw <= 10 ? activityRaw : null,
      upcomingBreaks: s("upcomingBreaks"),
      weeklyCommit: s("weeklyCommit"),
      outreach: s("outreach"),
      modCheck: s("modCheck"),
      respectPledge: s("respectPledge"),
      asyncExp: s("asyncExp"),
      comments: s("comments"),
      twitchFollow: s("twitchFollow"),
      bmpMmr: bmp?.rankedMmr ?? null,
      bmpTier: bmp?.rankedTier ?? null,
    });
    // Re-signing after pulling out / being passed over re-enters the pool.
    if (row.status === "WITHDRAWN" || row.status === "REJECTED") await setSignupStatus(row.id, "PENDING");
    revalidatePath("/signup");
    return { ok: true, message: `You're signed up${bmp ? ` — BMP rank pulled: ${bmp.rankedTier} (${bmp.rankedMmr} MMR)` : ""}. The committee will review your entry.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Sign-up failed." };
  }
}

export async function withdrawSignupAction(formData: FormData) {
  const v = await getViewer();
  if (!v.discordId) return;
  await withdrawSignup(String(formData.get("season") ?? ""), v.discordId);
  revalidatePath("/signup");
}
