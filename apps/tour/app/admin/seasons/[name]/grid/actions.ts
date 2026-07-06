"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { recordHoleResult, markPairNotScheduled, unmarkPairNotScheduled } from "@/lib/services/schedule-edit";
import type { ActionResult } from "@/lib/action-result";

// Coverage-grid schedule editing (TO-only): fill a hole with a team-level result, or
// mark/clear a designed non-matchup. Thin callers into lib/services/schedule-edit.
function revalidate(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/grid`);
  revalidatePath(`/admin/seasons/${enc}/audit`);
  revalidatePath(`/admin/seasons/${enc}/schedule`);
}

export async function recordHoleAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  const aId = String(formData.get("aId") ?? "");
  const bId = String(formData.get("bId") ?? "");
  const aName = String(formData.get("aName") ?? "Team A");
  const bName = String(formData.get("bName") ?? "Team B");
  const dq = formData.get("dq") === "1";
  try {
    const r = await recordHoleResult(season, aId, bId, {
      setsA: Number(formData.get("setsA")),
      setsB: Number(formData.get("setsB")),
      gamesA: formData.get("gamesA") ? Number(formData.get("gamesA")) : 0,
      gamesB: formData.get("gamesB") ? Number(formData.get("gamesB")) : 0,
      weekNumber: Number(formData.get("week")),
      dq,
    });
    revalidate(season);
    return {
      ok: true,
      message: dq
        ? `Recorded ${aName} vs ${bName} as a double DQ (0-0, nobody played) in week ${r.weekNumber}.`
        : `Recorded ${aName} ${formData.get("setsA")}-${formData.get("setsB")} ${bName} in week ${r.weekNumber}.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not record the result." };
  }
}

export async function markNotScheduledAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  const aName = String(formData.get("aName") ?? "Team A");
  const bName = String(formData.get("bName") ?? "Team B");
  try {
    await markPairNotScheduled(season, String(formData.get("aId") ?? ""), String(formData.get("bId") ?? ""));
    revalidate(season);
    return { ok: true, message: `Marked ${aName} vs ${bName} as never scheduled (a designed bye).` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not mark the pair." };
  }
}

export async function unmarkNotScheduledAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  const aName = String(formData.get("aName") ?? "Team A");
  const bName = String(formData.get("bName") ?? "Team B");
  try {
    await unmarkPairNotScheduled(season, String(formData.get("aId") ?? ""), String(formData.get("bId") ?? ""));
    revalidate(season);
    return { ok: true, message: `${aName} vs ${bName} is a fillable hole again.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not clear the mark." };
  }
}
