"use server";

// Actions for the week-by-week review hub. TO-only (isAdmin) -- this is cross-team
// season surgery, distinct from the captain-scoped matchup console. Each calls a
// service and revalidates the review page. Scores map our/their -> the set's A/B via
// the hidden `ourSlot` the page renders per pair.
import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { reportSet, unreportSet, dqSet } from "@/lib/services/report";
import { reviewReassignPlayer, reviewSetSeed } from "@/lib/services/review";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  revalidatePath(`/admin/seasons/${encodeURIComponent(season)}/review`);
}

export async function reportSetAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Admins only." };
  const season = String(formData.get("season") ?? "");
  const setId = String(formData.get("setId") ?? "");
  const ourSlot = formData.get("ourSlot") === "B" ? "B" : "A";
  const our = Number(formData.get("gamesOur"));
  const their = Number(formData.get("gamesTheir"));
  const gamesA = ourSlot === "A" ? our : their;
  const gamesB = ourSlot === "A" ? their : our;
  try {
    await reportSet(setId, gamesA, gamesB);
    rev(season);
    return { ok: true, message: "Result recorded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Report failed." };
  }
}

export async function clearSetAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Admins only." };
  const season = String(formData.get("season") ?? "");
  const setId = String(formData.get("setId") ?? "");
  try {
    await unreportSet(setId);
    rev(season);
    return { ok: true, message: "Result cleared." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Clear failed." };
  }
}

export async function dqSetAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Admins only." };
  const season = String(formData.get("season") ?? "");
  const setId = String(formData.get("setId") ?? "");
  try {
    await dqSet(setId);
    rev(season);
    return { ok: true, message: "Marked 0-0 (nobody played)." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function setSeedAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Admins only." };
  const season = String(formData.get("season") ?? "");
  const setId = String(formData.get("setId") ?? "");
  const slot = formData.get("slot") === "B" ? "B" : "A";
  const seed = Number(formData.get("seed"));
  try {
    await reviewSetSeed(setId, slot, seed);
    rev(season);
    return { ok: true, message: "Seed updated." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Seed update failed." };
  }
}

export async function reassignAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Admins only." };
  const season = String(formData.get("season") ?? "");
  const setId = String(formData.get("setId") ?? "");
  const side = formData.get("side") === "their" ? "their" : "our";
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  try {
    const r = await reviewReassignPlayer(setId, side, teamSeasonId, playerId);
    rev(season);
    return { ok: true, message: r.changed ? "Player updated." : "No change." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Reassign failed." };
  }
}
