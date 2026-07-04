"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { crownChampion, uncrownChampion } from "@/lib/services/season-end";
import { createAward, addAwardRecipient, removeAwardRecipient, removeAward } from "@/lib/services/awards";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/end`);
  revalidatePath(`/admin/seasons/${enc}`);
  revalidatePath(`/seasons/${enc}`);
}

// Per-row award/recipient buttons -> Sonner toast (not a banner). redirect throws NEXT_REDIRECT,
// so it must be called OUTSIDE the try.
function backToEnd(season: string, msg: string, ok = true): never {
  const qs = new URLSearchParams();
  qs.set(ok ? "ok" : "err", msg);
  redirect(`/admin/seasons/${encodeURIComponent(season)}/end?${qs.toString()}`);
}

export async function crownChampionAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    await crownChampion(season);
    rev(season);
    return { ok: true, message: "Champion crowned — season marked DONE." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not crown champion." };
  }
}

export async function uncrownChampionAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  await uncrownChampion(season);
  rev(season);
}

// Create an award shell (banner). kind "" -> a custom award (the service then requires a title).
export async function createAwardAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    await createAward(season, {
      kind: String(formData.get("kind") ?? "") || null,
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
    });
    rev(season);
    return { ok: true, message: "Award created — add its recipient(s) below." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't create the award." };
  }
}

export async function addRecipientAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  let msg = "Recipient added.";
  let ok = true;
  try {
    await addAwardRecipient(String(formData.get("awardId") ?? ""), {
      playerId: String(formData.get("playerId") ?? "") || null,
      teamId: String(formData.get("teamId") ?? "") || null,
      note: String(formData.get("note") ?? "") || null,
    });
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Couldn't add the recipient.";
  }
  rev(season);
  backToEnd(season, msg, ok);
}

export async function removeRecipientAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  let msg = "Recipient removed.";
  let ok = true;
  try {
    await removeAwardRecipient(String(formData.get("recipientId") ?? ""));
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Couldn't remove the recipient.";
  }
  rev(season);
  backToEnd(season, msg, ok);
}

export async function removeAwardAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  let msg = "Award removed.";
  let ok = true;
  try {
    await removeAward(String(formData.get("awardId") ?? ""));
  } catch (e) {
    ok = false;
    msg = e instanceof Error ? e.message : "Couldn't remove the award.";
  }
  rev(season);
  backToEnd(season, msg, ok);
}
