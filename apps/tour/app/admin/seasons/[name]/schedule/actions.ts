"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { generateSeasonSchedule, resetSchedule } from "@/lib/services/schedule";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/schedule`);
  revalidatePath(`/admin/seasons/${enc}`);
}

export async function generateScheduleAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!isAdmin()) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const r = await generateSeasonSchedule(season);
    rev(season);
    return { ok: true, message: `Schedule generated: ${r.weeks} weeks · ${r.matchups} matchups.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Generation failed." };
  }
}

export async function resetScheduleAction(formData: FormData) {
  if (!isAdmin()) return;
  const season = String(formData.get("season") ?? "");
  await resetSchedule(season);
  rev(season);
}
