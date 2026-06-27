"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth";
import { addSignup, withdrawSignup, setSignupStatus } from "@/lib/services/signups";
import type { ActionResult } from "@/lib/action-result";

// Self-serve signup. The identity is the AUTHENTICATED viewer's discordId — never a
// form field — so a player can only ever sign up / edit / withdraw themselves.
export async function submitSignupAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const v = await getViewer();
  if (!v.discordId) return { ok: false, message: "Sign in with Discord first." };
  const season = String(formData.get("season") ?? "");
  if (!season) return { ok: false, message: "No open season." };
  try {
    const row = await addSignup(season, {
      discordId: v.discordId,
      displayName: v.name ?? undefined,
      timezone: String(formData.get("timezone") ?? ""),
      availability: String(formData.get("availability") ?? ""),
      willingToCaptain: formData.get("willingToCaptain") === "on",
      bmpHandle: String(formData.get("bmpHandle") ?? ""),
    });
    // Re-signing after pulling out / being passed over re-enters the pool.
    if (row.status === "WITHDRAWN" || row.status === "REJECTED") await setSignupStatus(row.id, "PENDING");
    revalidatePath("/signup");
    return { ok: true, message: "You're signed up — the committee will review your entry." };
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
