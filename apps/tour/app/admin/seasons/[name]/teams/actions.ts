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

// Plain (non-ActionFlashForm) per-row actions redirect back with a toast message.
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

// Combined per-row edit: one Save writes name + conference + (when editable) captain in a
// single round-trip, instead of three separate mini-forms. Conference/captain are only
// applied when the row's edit form actually sent a value — an empty conferenceId means the
// select stayed on the "Unassigned" placeholder (not a real, settable option), and an empty
// captainDiscordId means the field wasn't rendered at all (captain is locked post-draft; see
// the page's structureLocked gate). setCaptain no-ops (returns unchanged) when the picked
// captain is already current, so re-submitting the unchanged value is always safe.
export async function updateTeamRowAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  const teamSeasonId = String(formData.get("teamSeasonId") ?? "");
  try {
    const renamed = await renameTeam(teamSeasonId, String(formData.get("teamName") ?? ""));

    const conferenceId = String(formData.get("conferenceId") ?? "");
    if (conferenceId) await setTeamConference(teamSeasonId, conferenceId);

    let captainNote = "";
    const captainDiscordId = String(formData.get("captainDiscordId") ?? "");
    if (captainDiscordId) {
      const cap = await setCaptain(season, teamSeasonId, captainDiscordId);
      if (!cap.unchanged) captainNote = ` Captain set to ${cap.captain}.`;
    }

    rev(season);
    return { ok: true, message: `Saved ${renamed.name}.${captainNote}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Update failed." };
  }
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
