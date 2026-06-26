"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { substitute, recordDrop, recordDQ, removeEvent } from "@/lib/services/roster-ops";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/roster`);
  revalidatePath(`/admin/seasons/${enc}`);
}

export async function substituteAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!isAdmin()) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    await substitute(
      season,
      String(formData.get("teamSeasonId") ?? ""),
      String(formData.get("outPlayerId") ?? ""),
      String(formData.get("inPlayerId") ?? ""),
      String(formData.get("weekBlock") ?? ""),
      String(formData.get("reason") ?? ""),
    );
    rev(season);
    return { ok: true, message: "Substitution recorded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Substitution failed." };
  }
}

export async function dropAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!isAdmin()) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    await recordDrop(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("playerId") ?? ""), String(formData.get("reason") ?? ""));
    rev(season);
    return { ok: true, message: "Drop recorded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not record drop." };
  }
}

export async function dqAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!isAdmin()) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    await recordDQ(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("playerId") ?? ""), String(formData.get("reason") ?? ""));
    rev(season);
    return { ok: true, message: "DQ recorded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not record DQ." };
  }
}

export async function removeEventAction(formData: FormData) {
  if (!isAdmin()) return;
  const season = String(formData.get("season") ?? "");
  await removeEvent(String(formData.get("eventId") ?? ""));
  rev(season);
}
