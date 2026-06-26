"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { setupDraft, resetDraft, makePick } from "@/lib/services/draft";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/draft`);
  revalidatePath(`/admin/seasons/${enc}`);
}

export async function setupDraftAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!isAdmin()) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const r = await setupDraft(season);
    rev(season);
    return { ok: true, message: `Draft built: ${r.teams} teams · ${r.rounds} rounds · ${r.picks} picks (${r.players} in pool).` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Setup failed." };
  }
}

export async function resetDraftAction(formData: FormData) {
  if (!isAdmin()) return;
  const season = String(formData.get("season") ?? "");
  await resetDraft(season);
  rev(season);
}

// Assign the on-the-clock pick to a pool player. Plain action (per-pool-player pick
// form); makePick can throw on a race (player already drafted) — swallow it, the
// board just re-renders unchanged.
export async function makePickAction(formData: FormData) {
  if (!isAdmin()) return;
  const season = String(formData.get("season") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  try {
    await makePick(season, playerId);
  } catch {
    /* race / already drafted — ignore */
  }
  rev(season);
}
