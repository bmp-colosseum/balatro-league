"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { createTeamForSeason, renameTeam, setTeamConference, setCaptain, deleteTeamSeason } from "@/lib/services/teams-admin";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/teams`);
  revalidatePath(`/admin/seasons/${enc}`);
  revalidatePath(`/seasons/${enc}`);
}

// Per-row table actions redirect back with a toast message (not an inline banner).
function backToTeams(season: string, msg: string, ok = true): never {
  redirect(`/admin/seasons/${encodeURIComponent(season)}/teams?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}

export async function createTeamAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const r = await createTeamForSeason(season, {
      captainDiscordId: String(formData.get("captainDiscordId") ?? ""),
      name: String(formData.get("teamName") ?? "").trim() || undefined,
      conferenceId: String(formData.get("conferenceId") ?? "") || undefined,
    });
    rev(season);
    return { ok: true, message: `Created ${r.teamName} — captain ${r.captain}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to create the team." };
  }
}

export async function renameTeamAdminAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    const r = await renameTeam(String(formData.get("teamSeasonId") ?? ""), String(formData.get("teamName") ?? ""));
    rev(season);
    return { ok: true, message: `Renamed to ${r.name}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Rename failed." };
  }
}

export async function setTeamConferenceAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  let msg = "Moved conference.";
  let ok = true;
  try {
    await setTeamConference(String(formData.get("teamSeasonId") ?? ""), String(formData.get("conferenceId") ?? ""));
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Move failed.";
  }
  rev(season);
  backToTeams(season, msg, ok);
}

export async function setCaptainAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  let msg = "Captain set.";
  let ok = true;
  try {
    const r = await setCaptain(season, String(formData.get("teamSeasonId") ?? ""), String(formData.get("captainDiscordId") ?? ""));
    msg = r.unchanged ? `${r.captain} already captains this team.` : `Captain set to ${r.captain}.`;
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Couldn't set the captain.";
  }
  rev(season);
  backToTeams(season, msg, ok);
}

export async function deleteTeamAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  let msg = "Team deleted.";
  let ok = true;
  try {
    const r = await deleteTeamSeason(String(formData.get("teamSeasonId") ?? ""));
    msg = `Deleted ${r.team}${r.setsDeleted ? ` (+${r.setsDeleted} sets)` : ""}.`;
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Delete failed.";
  }
  rev(season);
  backToTeams(season, msg, ok);
}
