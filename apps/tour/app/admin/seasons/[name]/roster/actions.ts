"use server";

import { revalidatePath } from "next/cache";
import { can, seasonIdByName } from "@/lib/permissions";
import { substitute, recordDeparture, reinstate, replacePlayer, removeMove, changeCaptain, reseed, swapSeeds } from "@/lib/services/roster-ops";
import { addStrike, removeStrike } from "@/lib/services/strikes";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/roster`);
  revalidatePath(`/admin/seasons/${enc}`);
}

// ROSTERS capability (or TO), or the captain of the given team (team-scoped). Actions without
// a teamSeasonId (strikes, remove-move) fall through to grant/TO only — not captains.
const allow = async (season: string, teamSeasonId: string) =>
  can("ROSTERS", { seasonId: await seasonIdByName(season), teamSeasonId: teamSeasonId || undefined });

const wk = (fd: FormData, key: string) => {
  const v = Number(fd.get(key));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

export async function substituteAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  const until = wk(formData, "untilWeek");
  try {
    await substitute(
      season,
      String(formData.get("teamSeasonId") ?? ""),
      String(formData.get("outPlayerId") ?? ""),
      String(formData.get("inPlayerId") ?? ""),
      wk(formData, "effectiveWeek"),
      until || null,
      String(formData.get("reason") ?? ""),
    );
    rev(season);
    return { ok: true, message: "Substitution recorded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Substitution failed." };
  }
}

export async function departureAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  const kind = formData.get("kind") === "BANNED" ? "BANNED" : "QUIT";
  try {
    await recordDeparture(kind, season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("playerId") ?? ""), wk(formData, "effectiveWeek"), String(formData.get("reason") ?? ""));
    rev(season);
    return { ok: true, message: `${kind === "BANNED" ? "Ban" : "Departure"} recorded.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not record." };
  }
}

export async function replaceAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  try {
    await replacePlayer(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("inPlayerId") ?? ""), String(formData.get("replacesPlayerId") ?? ""), wk(formData, "effectiveWeek"), String(formData.get("reason") ?? ""));
    rev(season);
    return { ok: true, message: "Replacement recorded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not record replacement." };
  }
}

export async function reinstateAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return;
  try {
    await reinstate(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("playerId") ?? ""), wk(formData, "effectiveWeek"), String(formData.get("reason") ?? ""));
  } catch {
    /* ignore — reinstate is best-effort from the timeline button */
  }
  rev(season);
}

export async function removeMoveAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return;
  await removeMove(String(formData.get("moveId") ?? ""));
  rev(season);
}

export async function changeCaptainAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  try {
    await changeCaptain(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("newCaptainPlayerId") ?? ""), wk(formData, "effectiveWeek"), String(formData.get("reason") ?? ""));
    rev(season);
    return { ok: true, message: "Captain updated." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not change captain." };
  }
}

export async function reseedAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  try {
    await reseed(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("playerId") ?? ""), Number(formData.get("newSeed")), wk(formData, "effectiveWeek"), String(formData.get("reason") ?? ""));
    rev(season);
    return { ok: true, message: "Player re-seeded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not re-seed." };
  }
}

export async function swapSeedsAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  try {
    await swapSeeds(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("playerAId") ?? ""), String(formData.get("playerBId") ?? ""), wk(formData, "effectiveWeek"), String(formData.get("reason") ?? ""));
    rev(season);
    return { ok: true, message: "Seeds swapped." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not swap seeds." };
  }
}

export async function addStrikeAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  try {
    await addStrike(String(formData.get("playerId") ?? ""), season, wk(formData, "week") || null, String(formData.get("kind") ?? "SCHEDULING"), String(formData.get("reason") ?? ""));
    rev(season);
    return { ok: true, message: "Strike recorded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not record strike." };
  }
}

export async function removeStrikeAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return;
  await removeStrike(String(formData.get("strikeId") ?? ""));
  rev(season);
}
