"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { generateSeasonSchedule, resetSchedule } from "@/lib/services/schedule";
import { setWeekDeadline, applyWeeklyCadence, clearAllDeadlines } from "@/lib/services/deadlines";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/schedule`);
  revalidatePath(`/admin/seasons/${enc}`);
}

export async function generateScheduleAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const r = await generateSeasonSchedule(season);
    rev(season);
    return { ok: true, message: `Schedule generated: ${r.weeks} weeks · ${r.matchups} matchups.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Generation failed." };
  }
}

// Soft deadlines: a target date the TO sets per week, or fills across the season on a
// weekly cadence. Never enforced -- blank = no target shown. Authored in ET.
export async function setWeekDeadlineAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  const week = Number(formData.get("week"));
  const wall = String(formData.get("deadline") ?? "").trim() || null;
  try {
    const r = await setWeekDeadline(season, week, wall);
    rev(season);
    return { ok: true, message: r.cleared ? `Week ${week} target cleared.` : `Week ${week} target set.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't set the target." };
  }
}

export async function applyCadenceAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  const first = String(formData.get("first") ?? "").trim();
  const interval = Number(formData.get("interval")) || 7;
  try {
    const r = await applyWeeklyCadence(season, first, interval);
    rev(season);
    return { ok: true, message: `Targets set for ${r.count} week(s), every ${interval} days.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't apply the cadence." };
  }
}

export async function clearDeadlinesAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const r = await clearAllDeadlines(season);
    rev(season);
    return { ok: true, message: `Cleared targets on ${r.count} week(s).` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't clear targets." };
  }
}

export async function resetScheduleAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  let msg = "Schedule reset — all weeks and matchups cleared.";
  let ok = true;
  try {
    await resetSchedule(season);
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Reset failed.";
  }
  rev(season);
  redirect(`/admin/seasons/${encodeURIComponent(season)}/schedule?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}
