"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { addSignup, setSignupStatus, setSignupStatusBulk, removeSignup, type SignupStatus } from "@/lib/services/signups";
import { createTeamForSeason } from "@/lib/services/teams-admin";
import type { ActionResult } from "@/lib/action-result";

function revalidate(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/signups`);
  revalidatePath(`/admin/seasons/${enc}`);
}

// Redirect back to the signups queue (keeping the active tab) with a toast message —
// per-row table actions surface as a Sonner toast, not an inline banner.
function backToSignups(season: string, tab: string, msg: string, ok = true): never {
  const qs = new URLSearchParams();
  if (tab && tab !== "pending") qs.set("tab", tab);
  qs.set(ok ? "ok" : "err", msg);
  redirect(`/admin/seasons/${encodeURIComponent(season)}/signups?${qs.toString()}`);
}

export async function addSignupAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    // force: the committee can add a latecomer even after signups close.
    const s = await addSignup(season, {
      discordId: String(formData.get("discordId") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
      timezone: String(formData.get("timezone") ?? ""),
      captainInterest: String(formData.get("captainInterest") ?? "") || undefined,
      bmpHandle: String(formData.get("bmpHandle") ?? ""),
    }, { force: true });
    revalidate(season);
    return { ok: true, message: `Added ${s.displayName ?? s.discordId} to the pool.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to add signup." };
  }
}

export async function setSignupStatusAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  const tab = String(formData.get("tab") ?? "");
  const status = String(formData.get("status") ?? "") as SignupStatus;
  let msg: string;
  let ok = true;
  try {
    const s = await setSignupStatus(String(formData.get("id") ?? ""), status);
    const verb = status === "APPROVED" ? "Approved" : status === "REJECTED" ? "Rejected" : status.toLowerCase();
    msg = `${verb} ${s.displayName ?? s.discordId}.`;
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Status change failed.";
  }
  revalidate(season);
  backToSignups(season, tab, msg, ok);
}

// Bulk approve/reject — the submit button's value carries the target status.
export async function bulkSignupStatusAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  const status = String(formData.get("bulkStatus") ?? "") as SignupStatus;
  if (status !== "APPROVED" && status !== "REJECTED") return { ok: false, message: "Pick approve or reject." };
  const ids = formData.getAll("ids").map(String).filter(Boolean);
  if (!ids.length) return { ok: false, message: "Select at least one signup first." };
  const n = await setSignupStatusBulk(ids, status);
  revalidate(season);
  return { ok: true, message: `${n} signup${n === 1 ? "" : "s"} ${status === "APPROVED" ? "approved" : "rejected"}.` };
}

// One-click promote: create this approved signup's team right here (default "Team {name}"),
// so captaining happens inline in the review flow instead of a trip to the Teams page.
export async function makeCaptainAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  const tab = String(formData.get("tab") ?? "");
  let msg: string;
  let ok = true;
  try {
    const r = await createTeamForSeason(season, { captainDiscordId: String(formData.get("discordId") ?? "") });
    msg = `Made ${r.captain} captain of ${r.teamName}.`;
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Couldn't create the team.";
  }
  revalidate(season);
  backToSignups(season, tab, msg, ok);
}

export async function removeSignupAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  const tab = String(formData.get("tab") ?? "");
  let msg = "Signup removed.";
  let ok = true;
  try {
    await removeSignup(String(formData.get("id") ?? ""));
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Remove failed.";
  }
  revalidate(season);
  backToSignups(season, tab, msg, ok);
}
