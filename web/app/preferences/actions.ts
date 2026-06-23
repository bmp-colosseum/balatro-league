"use server";

import { revalidatePath } from "next/cache";
import { setShowBmpMmr, setShowUsernames } from "@/lib/preferences";

// Flip the show-BMP-MMR cookie. Reads current state from the submitted
// form so the same action handles both directions (show + hide) — caller
// just renders the opposite of the current value as the form's intent.
export async function toggleShowBmpMmr(formData: FormData) {
  const next = String(formData.get("next") ?? "") === "1";
  await setShowBmpMmr(next);
  // Revalidate the path the toggle was hit from so the column shows/hides
  // immediately rather than waiting for the next navigation.
  const returnTo = String(formData.get("returnTo") ?? "/");
  revalidatePath(returnTo);
}

// Flip the show-Discord-usernames cookie (public; default on).
export async function toggleShowUsernames(formData: FormData) {
  const next = String(formData.get("next") ?? "") === "1";
  await setShowUsernames(next);
  const returnTo = String(formData.get("returnTo") ?? "/");
  revalidatePath(returnTo);
}
