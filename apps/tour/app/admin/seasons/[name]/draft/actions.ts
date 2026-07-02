"use server";

import { revalidatePath } from "next/cache";
import { can, seasonIdByName } from "@/lib/permissions";
import { setupDraft, resetDraft, makePick, reassignDraftPick, onClockTeam } from "@/lib/services/draft";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/draft`);
  revalidatePath(`/admin/seasons/${enc}`);
}

// DRAFT capability (or TO) — the draft runner. Structural ops (setup/reset/reassign) are
// runner-only (no team scope). A pick is additionally allowed for the on-clock team's captain.
const allowRun = async (season: string) => can("DRAFT", { seasonId: await seasonIdByName(season) });

export async function setupDraftAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allowRun(season))) return { ok: false, message: "Not authorized." };
  try {
    const r = await setupDraft(season);
    rev(season);
    return { ok: true, message: `Draft built: ${r.teams} teams · ${r.rounds} rounds · ${r.picks} picks (${r.players} in pool).` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Setup failed." };
  }
}

export async function reassignPickAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allowRun(season))) return { ok: false, message: "Not authorized." };
  try {
    await reassignDraftPick(String(formData.get("pickId") ?? ""), String(formData.get("playerId") ?? ""));
    rev(season);
    revalidatePath(`/seasons/${encodeURIComponent(season)}/draft`);
    return { ok: true, message: "Pick reassigned." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not reassign." };
  }
}

export async function resetDraftAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allowRun(season))) return;
  await resetDraft(season);
  rev(season);
}

// Assign the on-the-clock pick to a pool player. Plain action (per-pool-player pick
// form); makePick can throw on a race (player already drafted) — swallow it, the
// board just re-renders unchanged.
export async function makePickAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  // The DRAFT runner (or TO) can pick any slot; a captain can pick when their team is on the clock.
  if (!(await can("DRAFT", { seasonId: await seasonIdByName(season), teamSeasonId: (await onClockTeam(season)) ?? undefined }))) return;
  const playerId = String(formData.get("playerId") ?? "");
  try {
    await makePick(season, playerId);
  } catch {
    /* race / already drafted — ignore */
  }
  rev(season);
}
