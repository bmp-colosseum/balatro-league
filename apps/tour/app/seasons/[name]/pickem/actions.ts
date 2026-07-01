"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth";
import { makePick } from "@/lib/services/pickem";

export async function makePickAction(formData: FormData) {
  const v = await getViewer();
  if (!v.discordId) return; // must be signed in
  const season = String(formData.get("season") ?? "");
  const setId = String(formData.get("setId") ?? "");
  const pickedPlayerId = String(formData.get("pickedPlayerId") ?? "");
  try {
    await makePick(v.discordId, v.name ?? null, setId, pickedPlayerId);
  } catch {
    /* locked/invalid — ignore; the page re-renders with current state */
  }
  revalidatePath(`/seasons/${encodeURIComponent(season)}/pickem`);
}
