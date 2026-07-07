"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { can, seasonIdByName } from "@/lib/permissions";
import { substitute, recordDeparture, reinstate, replacePlayer, removeMove, changeCaptain, reseed, swapSeeds, setCoCaptain, convertMemberToSub, convertSubToMember } from "@/lib/services/roster-ops";
import { addStrike, removeStrike } from "@/lib/services/strikes";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/roster`);
  revalidatePath(`/admin/seasons/${enc}`);
}

// Per-row timeline actions redirect back with a toast message (not an inline banner).
function backToRoster(season: string, msg: string, ok = true): never {
  redirect(`/admin/seasons/${encodeURIComponent(season)}/roster?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
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
    const from = wk(formData, "effectiveWeek");
    const r = await substitute(
      season,
      String(formData.get("teamSeasonId") ?? ""),
      String(formData.get("outPlayerId") ?? ""),
      String(formData.get("inPlayerId") ?? ""),
      from,
      until || null,
      String(formData.get("reason") ?? ""),
    );
    rev(season);
    const window = until && until !== from ? `W${from}-${until}` : `W${from} only`;
    const moved = r.reassigned > 0 ? ` ${r.reassigned} unplayed set(s) (W${r.weeks.join(", W")}) moved to the sub.` : "";
    return { ok: true, message: `Substitution recorded for ${window}.${moved}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Substitution failed." };
  }
}

// Membership fix: a permanent member (usually a bad import) is actually a temporary sub.
export async function convertToSubAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  const until = wk(formData, "untilWeek");
  try {
    const r = await convertMemberToSub(
      season,
      String(formData.get("teamSeasonId") ?? ""),
      String(formData.get("playerId") ?? ""),
      wk(formData, "effectiveWeek"),
      until || null,
      String(formData.get("outPlayerId") ?? "") || null,
      String(formData.get("reason") ?? ""),
    );
    rev(season);
    const from = wk(formData, "effectiveWeek");
    const window = until && until !== from ? `W${from}-${until}` : `W${from} only`;
    const weeks = r.playedWeeks.length ? ` They played in W${r.playedWeeks.join(", W")}.` : " They have no played sets on this team.";
    const warn = r.outside.length ? ` Heads-up: W${r.outside.join(", W")} falls outside that window -- re-run with a wider window if that's wrong.` : "";
    return { ok: true, message: `Converted to a sub covering ${window}.${weeks}${warn}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Convert failed." };
  }
}

// The reverse: a sub who is actually a permanent member.
export async function makePermanentAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return { ok: false, message: "Not authorized." };
  const seed = Number(formData.get("seed"));
  try {
    await convertSubToMember(
      season,
      String(formData.get("teamSeasonId") ?? ""),
      String(formData.get("playerId") ?? ""),
      wk(formData, "effectiveWeek"),
      Number.isFinite(seed) && seed > 0 ? seed : null,
      String(formData.get("reason") ?? ""),
    );
    rev(season);
    return { ok: true, message: "Sub converted to a permanent member." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Convert failed." };
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
    const r = await replacePlayer(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("inPlayerId") ?? ""), String(formData.get("replacesPlayerId") ?? ""), wk(formData, "effectiveWeek"), String(formData.get("reason") ?? ""));
    rev(season);
    const moved = r.reassigned > 0 ? ` ${r.reassigned} unplayed set(s) (W${r.weeks.join(", W")}) moved to them.` : "";
    return { ok: true, message: `Replacement recorded.${moved}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not record replacement." };
  }
}

export async function reinstateAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return;
  let msg = "Player reinstated.";
  let ok = true;
  try {
    await reinstate(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("playerId") ?? ""), wk(formData, "effectiveWeek"), String(formData.get("reason") ?? ""));
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Reinstate failed.";
  }
  rev(season);
  backToRoster(season, msg, ok);
}

export async function removeMoveAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season, String(formData.get("teamSeasonId") ?? "")))) return;
  let msg = "Move removed from the timeline.";
  let ok = true;
  try {
    await removeMove(String(formData.get("moveId") ?? ""));
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Could not remove the move.";
  }
  rev(season);
  backToRoster(season, msg, ok);
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

// Designate/remove a co-captain — allowed for the TO, a ROSTERS mod, or the team's own captain.
export async function setCoCaptainAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  if (!(await allow(season, teamSeasonId))) return { ok: false, message: "Not authorized." };
  try {
    const on = formData.get("isCoCaptain") === "true";
    await setCoCaptain(teamSeasonId, String(formData.get("playerId") ?? ""), on);
    rev(season);
    return { ok: true, message: on ? "Co-captain designated." : "Co-captain removed." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not update co-captain." };
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
  let msg = "Reliability note removed.";
  let ok = true;
  try {
    await removeStrike(String(formData.get("strikeId") ?? ""));
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Could not remove the note.";
  }
  rev(season);
  backToRoster(season, msg, ok);
}
