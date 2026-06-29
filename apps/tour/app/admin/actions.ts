"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertAdmin, isAdmin } from "@/lib/auth";
import { createSeason, updateSeason } from "@/lib/services/seasons";
import { importFromZip } from "@/lib/services/import-upload";
import type { ActionResult } from "@/lib/action-result";

// Server actions = thin form wrappers over the same services the API route calls.
export async function createSeasonAction(formData: FormData) {
  await assertAdmin();
  await createSeason({
    name: String(formData.get("name") ?? ""),
    format: String(formData.get("format") ?? "SWISS") as "SWISS" | "CONFERENCES",
    teamSize: Number(formData.get("teamSize") ?? 11),
    setsToWin: Number(formData.get("setsToWin") ?? 0) || undefined,
    conferenceCount: Number(formData.get("conferenceCount") ?? 2),
    playoffTeams: Number(formData.get("playoffTeams") ?? 8),
  });
  revalidatePath("/admin");
  revalidatePath("/");
  redirect("/admin");
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
    const r = await importFromZip(buf);
    revalidatePath("/admin");
    revalidatePath("/");
    const parts: string[] = [];
    if (r.historical) parts.push(`${r.historical.players} players · ${r.historical.teamSeasons} team-seasons · ${r.historical.tourSets} sets`);
    if (r.conference) parts.push(`conference: ${r.conference.teams} teams · ${r.conference.matchups} matchups`);
    if (r.leagueRef) parts.push(`${r.leagueRef} league refs (for identity linking)`);
    if (r.signups?.stored) parts.push(`${r.signups.stored} signup handles`);
    const skipped = r.errors.length ? ` (skipped ${r.errors.map((e) => e.which).join(", ")})` : "";
    return { ok: true, message: `Imported ${r.ran.join(" + ")} — ${parts.join("; ")}${skipped}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Import failed." };
  }
}

export async function updateSeasonStateAction(formData: FormData) {
  await assertAdmin();
  const name = String(formData.get("name") ?? "");
  const state = String(formData.get("state") ?? "") as
    | "SIGNUPS"
    | "DRAFTING"
    | "REGULAR"
    | "PLAYOFFS"
    | "DONE";
  await updateSeason(name, { state });
  revalidatePath("/admin");
  revalidatePath(`/admin/seasons/${encodeURIComponent(name)}`);
  revalidatePath(`/seasons/${encodeURIComponent(name)}`);
}
