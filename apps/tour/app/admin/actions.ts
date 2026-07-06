"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertAdmin, isAdmin } from "@/lib/auth";
import { createSeason, updateSeason, addConference, renameConference, removeConference } from "@/lib/services/seasons";
import { importFromZip, previewFromZip } from "@/lib/services/import-upload";
import type { ActionResult } from "@/lib/action-result";

// Creation is minimal (name only) — structure is decided later in Season settings once
// the signup pool's size is known. Lands on the new season's hub.
export async function createSeasonAction(formData: FormData) {
  await assertAdmin();
  const name = String(formData.get("name") ?? "").trim();
  await createSeason({ name });
  revalidatePath("/admin");
  revalidatePath("/");
  redirect(`/admin/seasons/${encodeURIComponent(name)}`);
}

// Import history from an uploaded .zip of the sheets (works in prod — no local
// folder dependency). ActionResult-returning so the upload UI shows the outcome.
export async function uploadImportAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, message: "Pick a .zip of the sheets folder." };
  if (!file.name.toLowerCase().endsWith(".zip")) return { ok: false, message: "That's not a .zip." };
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    // Preview (dry-run): parse + report what WOULD import, write nothing.
    if (formData.get("preview") === "1") {
      const p = await previewFromZip(buf);
      if (!p.seasons.length) return { ok: false, message: "No TT<n>.xlsx workbooks found in the zip." };
      const lines = p.seasons.map((s) => `TT${s.season} (${s.format}): ${s.teams} teams, ${s.players} players, ${s.weeks} weeks, ${s.regularSets} regular + ${s.playoffSets} playoff sets${s.champion ? `, champion ${s.champion}` : ""}`);
      return { ok: true, message: `Preview — nothing imported:\n${lines.join("\n")}` };
    }
    const r = await importFromZip(buf);
    revalidatePath("/admin");
    revalidatePath("/");
    const parts: string[] = [];
    if (r.imported) parts.push(`${r.imported.seasons} seasons · ${r.imported.teams} teams · ${r.imported.totalPlayers} players · ${r.imported.totalSets} sets · ${r.imported.champions} champions`);
    if (r.leagueRef) parts.push(`${r.leagueRef} league refs (for identity linking)`);
    if (r.signups?.stored) parts.push(`${r.signups.stored} signup handles`);
    const skipped = r.errors.length ? ` (skipped ${r.errors.map((e) => e.which).join(", ")})` : "";
    return { ok: true, message: `Imported ${r.ran.join(" + ")} — ${parts.join("; ")}${skipped}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Import failed." };
  }
}

const STATE_LABEL: Record<string, string> = { SIGNUPS: "Signups open", SIGNUPS_CLOSED: "Signups closed", DRAFTING: "Drafting", REGULAR: "Regular season", PLAYOFFS: "Playoffs", DONE: "Done" };

export async function updateSeasonStateAction(formData: FormData) {
  await assertAdmin();
  const name = String(formData.get("name") ?? "");
  const state = String(formData.get("state") ?? "") as
    | "SIGNUPS"
    | "SIGNUPS_CLOSED"
    | "DRAFTING"
    | "REGULAR"
    | "PLAYOFFS"
    | "DONE";
  let msg = `State set to ${STATE_LABEL[state] ?? state}.`;
  let ok = true;
  try {
    await updateSeason(name, { state });
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Could not change state.";
  }
  revalidatePath("/admin");
  revalidatePath(`/seasons/${encodeURIComponent(name)}`);
  revalidatePath("/signup");
  redirect(`/admin/seasons/${encodeURIComponent(name)}?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}

function revSeason(name: string) {
  revalidatePath(`/admin/seasons/${encodeURIComponent(name)}`);
  revalidatePath(`/seasons/${encodeURIComponent(name)}`);
}

// Season settings (structure — decided once the pool is known; locked after the draft).
export async function updateSeasonSettingsAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const name = String(formData.get("name") ?? "");
  try {
    await updateSeason(name, {
      // Only patch fields the submitting form actually carried -- the locked-season
      // mini-form posts just defaultBestOf, and must not flip format/size defaults.
      ...(formData.get("format") != null ? { format: formData.get("format") === "SWISS" ? "SWISS" as const : "CONFERENCES" as const } : {}),
      teamSize: Number(formData.get("teamSize")) || undefined,
      setsToWin: Number(formData.get("setsToWin")) || undefined,
      playoffTeams: Number(formData.get("playoffTeams")) || undefined,
      defaultBestOf: Number(formData.get("defaultBestOf")) || undefined,
    });
    revSeason(name);
    return { ok: true, message: "Settings saved." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Save failed." };
  }
}

export async function addConferenceAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const name = String(formData.get("season") ?? "");
  try {
    const c = await addConference(name, String(formData.get("confName") ?? ""));
    revSeason(name);
    return { ok: true, message: `Added "${c.name}".` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function renameConferenceAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const name = String(formData.get("season") ?? "");
  try {
    await renameConference(String(formData.get("conferenceId") ?? ""), String(formData.get("confName") ?? ""));
    revSeason(name);
    return { ok: true, message: "Renamed." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function removeConferenceAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const name = String(formData.get("season") ?? "");
  let msg = "Conference removed.";
  let ok = true;
  try {
    const c = await removeConference(String(formData.get("conferenceId") ?? ""));
    msg = `Removed "${c.name}".`;
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Could not remove the conference.";
  }
  revSeason(name);
  redirect(`/admin/seasons/${encodeURIComponent(name)}?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}
