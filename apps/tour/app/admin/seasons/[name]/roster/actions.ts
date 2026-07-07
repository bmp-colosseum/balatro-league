"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer, type Viewer } from "@/lib/auth";
import { capabilitiesFor, captainTeamsFor, seasonIdByName } from "@/lib/permissions";
import { substitute, recordDeparture, reinstate, replacePlayer, removeMove, changeCaptain, reseed, swapSeeds, setCoCaptain, convertMemberToSub, convertSubToMember } from "@/lib/services/roster-ops";
import { createRosterRequest, approveRosterRequest, rejectRosterRequest, cancelRosterRequest, approveManyRosterRequests, type RosterRequestPayload } from "@/lib/services/roster-requests";
import { addStrike, removeStrike } from "@/lib/services/strikes";
import { notifyLive } from "@/lib/notify";
import type { ActionResult } from "@/lib/action-result";

// Nudge the mod inbox (SSE) after a request decision so a handled row vanishes for other mods.
async function notifyRequests(season: string) {
  const sid = await seasonIdByName(season);
  if (sid) await notifyLive(`roster-requests:${sid}`);
}

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/roster`);
  revalidatePath(`/admin/seasons/${enc}/roster/requests`);
  revalidatePath(`/admin/seasons/${enc}`);
}

// Per-row timeline actions redirect back with a toast message (not an inline banner).
function backToRoster(season: string, msg: string, ok = true): never {
  redirect(`/admin/seasons/${encodeURIComponent(season)}/roster?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}

// Who is acting, and how. Mods (TO or ROSTERS grant) apply roster ops directly; a
// captain of the given team can only REQUEST them (they land as pending approvals);
// anyone else is denied. "Everything gates" for captains -- this is that gate.
async function actorMode(season: string, teamSeasonId: string): Promise<{ mode: "apply" | "request" | "deny"; viewer: Viewer }> {
  const viewer = await getViewer();
  const seasonId = await seasonIdByName(season);
  const isMod = viewer.tier === "OWNER" || viewer.tier === "TO" || (await capabilitiesFor(viewer, seasonId)).has("ROSTERS");
  if (isMod) return { mode: "apply", viewer };
  if (teamSeasonId && (await captainTeamsFor(viewer, seasonId)).has(teamSeasonId)) return { mode: "request", viewer };
  return { mode: "deny", viewer };
}

// Mod-only gate for the admin-surgery tools (timeline edits, membership fixes, strikes)
// that captains never touch, request or otherwise.
async function isModFor(season: string): Promise<boolean> {
  const viewer = await getViewer();
  if (viewer.tier === "OWNER" || viewer.tier === "TO") return true;
  return (await capabilitiesFor(viewer, await seasonIdByName(season))).has("ROSTERS");
}

// Route a captain-facing roster op: a mod runs `apply` now; a captain files `payload`
// as a pending request; anyone else is refused.
async function gated(season: string, teamSeasonId: string, payload: RosterRequestPayload, apply: () => Promise<ActionResult>): Promise<ActionResult> {
  const { mode, viewer } = await actorMode(season, teamSeasonId);
  if (mode === "deny") return { ok: false, message: "Not authorized." };
  if (mode === "request") {
    if (!viewer.discordId) return { ok: false, message: "Link your Discord before requesting roster changes." };
    try {
      await createRosterRequest({ seasonName: season, teamSeasonId, requestedBy: viewer.discordId, requestedName: viewer.name, ...payload });
      rev(season);
      return { ok: true, message: "Request submitted -- a mod will review and apply it." };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Could not submit request." };
    }
  }
  return apply();
}

const wk = (fd: FormData, key: string) => {
  const v = Number(fd.get(key));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

export async function substituteAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const outPlayerId = String(formData.get("outPlayerId") ?? "");
  const inPlayerId = String(formData.get("inPlayerId") ?? "");
  const from = wk(formData, "effectiveWeek");
  const until = wk(formData, "untilWeek");
  const reason = String(formData.get("reason") ?? "");
  return gated(
    season,
    teamSeasonId,
    { kind: "SUB", playerId: inPlayerId, outPlayerId, effectiveWeek: from, untilWeek: until || null, reason },
    async () => {
      try {
        const r = await substitute(season, teamSeasonId, outPlayerId, inPlayerId, from, until || null, reason);
        rev(season);
        const window = until && until !== from ? `W${from}-${until}` : `W${from} only`;
        const moved = r.reassigned > 0 ? ` ${r.reassigned} unplayed set(s) (W${r.weeks.join(", W")}) moved to the sub.` : "";
        return { ok: true, message: `Substitution recorded for ${window}.${moved}` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Substitution failed." };
      }
    },
  );
}

// Membership fix: a permanent member (usually a bad import) is actually a temporary sub. Mod-only surgery.
export async function convertToSubAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await isModFor(season))) return { ok: false, message: "Not authorized." };
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

// The reverse: a sub who is actually a permanent member. Mod-only surgery.
export async function makePermanentAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await isModFor(season))) return { ok: false, message: "Not authorized." };
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
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const kind = formData.get("kind") === "BANNED" ? "BANNED" : "QUIT";
  const playerId = String(formData.get("playerId") ?? "");
  const from = wk(formData, "effectiveWeek");
  const reason = String(formData.get("reason") ?? "");
  return gated(
    season,
    teamSeasonId,
    { kind, playerId, effectiveWeek: from, reason },
    async () => {
      try {
        await recordDeparture(kind, season, teamSeasonId, playerId, from, reason);
        rev(season);
        return { ok: true, message: `${kind === "BANNED" ? "Ban" : "Departure"} recorded.` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Could not record." };
      }
    },
  );
}

export async function replaceAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const inPlayerId = String(formData.get("inPlayerId") ?? "");
  const replacesPlayerId = String(formData.get("replacesPlayerId") ?? "");
  const from = wk(formData, "effectiveWeek");
  const reason = String(formData.get("reason") ?? "");
  return gated(
    season,
    teamSeasonId,
    { kind: "REPLACE", playerId: inPlayerId, replacesPlayerId, effectiveWeek: from, reason },
    async () => {
      try {
        const r = await replacePlayer(season, teamSeasonId, inPlayerId, replacesPlayerId, from, reason);
        rev(season);
        const moved = r.reassigned > 0 ? ` ${r.reassigned} unplayed set(s) (W${r.weeks.join(", W")}) moved to them.` : "";
        return { ok: true, message: `Replacement recorded.${moved}` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Could not record replacement." };
      }
    },
  );
}

// Bringing back a quit/banned player is TO/mod surgery, not a captain request.
export async function reinstateAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await isModFor(season))) return;
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
  if (!(await isModFor(season))) return;
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
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const newCaptainPlayerId = String(formData.get("newCaptainPlayerId") ?? "");
  const from = wk(formData, "effectiveWeek");
  const reason = String(formData.get("reason") ?? "");
  return gated(
    season,
    teamSeasonId,
    { kind: "CAPTAIN_CHANGE", playerId: newCaptainPlayerId, effectiveWeek: from, reason },
    async () => {
      try {
        await changeCaptain(season, teamSeasonId, newCaptainPlayerId, from, reason);
        rev(season);
        return { ok: true, message: "Captain updated." };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Could not change captain." };
      }
    },
  );
}

export async function reseedAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  const newSeed = Number(formData.get("newSeed"));
  const from = wk(formData, "effectiveWeek");
  const reason = String(formData.get("reason") ?? "");
  return gated(
    season,
    teamSeasonId,
    { kind: "RESEED", playerId, seed: Number.isFinite(newSeed) ? newSeed : null, effectiveWeek: from, reason },
    async () => {
      try {
        await reseed(season, teamSeasonId, playerId, newSeed, from, reason);
        rev(season);
        return { ok: true, message: "Player re-seeded." };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Could not re-seed." };
      }
    },
  );
}

export async function swapSeedsAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const playerAId = String(formData.get("playerAId") ?? "");
  const playerBId = String(formData.get("playerBId") ?? "");
  const from = wk(formData, "effectiveWeek");
  const reason = String(formData.get("reason") ?? "");
  return gated(
    season,
    teamSeasonId,
    { kind: "SWAP", playerId: playerAId, playerBId, effectiveWeek: from, reason },
    async () => {
      try {
        await swapSeeds(season, teamSeasonId, playerAId, playerBId, from, reason);
        rev(season);
        return { ok: true, message: "Seeds swapped." };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Could not swap seeds." };
      }
    },
  );
}

// Designate/remove a co-captain -- a captain requests, a mod applies.
export async function setCoCaptainAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  const on = formData.get("isCoCaptain") === "true";
  return gated(
    season,
    teamSeasonId,
    { kind: "CO_CAPTAIN", playerId, isCoCaptain: on, effectiveWeek: 0 },
    async () => {
      try {
        await setCoCaptain(teamSeasonId, playerId, on);
        rev(season);
        return { ok: true, message: on ? "Co-captain designated." : "Co-captain removed." };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Could not update co-captain." };
      }
    },
  );
}

export async function addStrikeAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await isModFor(season))) return { ok: false, message: "Not authorized." };
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
  if (!(await isModFor(season))) return;
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

// ── Request decisions (mod inbox + inline panel) ────────────────────────────
export async function approveRequestAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!(await isModFor(season))) return { ok: false, message: "Not authorized." };
  const viewer = await getViewer();
  try {
    const r = await approveRosterRequest(id, viewer.discordId ?? viewer.name ?? "mod");
    rev(season);
    await notifyRequests(season);
    return { ok: true, message: `Approved: ${r.summary}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not approve." };
  }
}

export async function rejectRequestAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!(await isModFor(season))) return { ok: false, message: "Not authorized." };
  const viewer = await getViewer();
  try {
    await rejectRosterRequest(id, viewer.discordId ?? viewer.name ?? "mod", String(formData.get("note") ?? ""));
    rev(season);
    await notifyRequests(season);
    return { ok: true, message: "Request rejected." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not reject." };
  }
}

// The requesting captain (or any mod) may withdraw a still-pending request.
export async function cancelRequestAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  const id = String(formData.get("id") ?? "");
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  const { mode, viewer } = await actorMode(season, teamSeasonId);
  if (mode === "deny") return { ok: false, message: "Not authorized." };
  try {
    await cancelRosterRequest(id, viewer.discordId ?? viewer.name ?? "captain");
    rev(season);
    await notifyRequests(season);
    return { ok: true, message: "Request withdrawn." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not withdraw." };
  }
}

// Bulk approve from the inbox -- row checkboxes join this via form="bulk-approve-req".
export async function approveRequestsBulkAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await isModFor(season))) return { ok: false, message: "Not authorized." };
  const ids = formData.getAll("ids").map(String).filter(Boolean);
  if (!ids.length) return { ok: false, message: "Tick at least one request to approve." };
  const viewer = await getViewer();
  const r = await approveManyRosterRequests(ids, viewer.discordId ?? viewer.name ?? "mod");
  rev(season);
  await notifyRequests(season);
  const failMsg = r.failed.length ? ` ${r.failed.length} could not be applied.` : "";
  return { ok: r.approved > 0, message: `Approved ${r.approved} request${r.approved === 1 ? "" : "s"}.${failMsg}` };
}
