"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { can, seasonIdByName } from "@/lib/permissions";
import { createRanking, updateRanking, deleteRanking, addRankingEntry, removeRankingEntry } from "@/lib/services/rankings";
import type { ActionResult } from "@/lib/action-result";

// RANKINGS capability (or TO), scoped to the season being edited.
const allow = async (season: string) => can("RANKINGS", { seasonId: await seasonIdByName(season) });

function rev(season: string, id?: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/rankings`);
  if (id) revalidatePath(`/admin/seasons/${enc}/rankings/${id}`);
  revalidatePath(`/seasons/${enc}/rankings`);
  revalidatePath(`/seasons/${enc}`);
}
const wk = (fd: FormData) => { const v = fd.get("week"); const n = Number(v); return v != null && String(v).trim() !== "" && Number.isFinite(n) && n > 0 ? n : null; };
// "YYYY-MM-DD" -> local-noon Date (noon avoids day-shift across timezones); empty -> null (keep default/current).
const postedAt = (fd: FormData): Date | null => { const v = String(fd.get("postedAt") ?? "").trim(); if (!v) return null; const d = new Date(`${v}T12:00:00`); return Number.isNaN(d.getTime()) ? null : d; };

export async function createRankingAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season))) return;
  const r = await createRanking(season, {
    kind: String(formData.get("kind") ?? "TEAM") === "PLAYER" ? "PLAYER" : "TEAM",
    week: wk(formData),
    title: String(formData.get("title") ?? ""),
    author: String(formData.get("author") ?? "") || null,
    authorPlayerId: String(formData.get("authorPlayerId") ?? "") || null,
    postedAt: postedAt(formData),
  });
  rev(season, r.id);
  redirect(`/admin/seasons/${encodeURIComponent(season)}/rankings/${r.id}`);
}

export async function deleteRankingAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season))) return;
  await deleteRanking(String(formData.get("id") ?? ""));
  rev(season);
}

export async function updateRankingAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season))) return { ok: false, message: "Not authorized." };
  const id = String(formData.get("id") ?? "");
  try {
    await updateRanking(id, { week: wk(formData), title: String(formData.get("title") ?? ""), author: String(formData.get("author") ?? "") || null, authorPlayerId: String(formData.get("authorPlayerId") ?? "") || null, postedAt: postedAt(formData) });
    rev(season, id);
    return { ok: true, message: "Saved." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function addEntryAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season))) return { ok: false, message: "Not authorized." };
  const id = String(formData.get("rankingId") ?? "");
  try {
    const pos = Number(formData.get("position"));
    await addRankingEntry(id, { targetId: String(formData.get("targetId") ?? ""), tier: String(formData.get("tier") ?? "") || null, note: String(formData.get("note") ?? "") || null, position: Number.isFinite(pos) && pos > 0 ? pos : undefined });
    rev(season, id);
    return { ok: true, message: "Added." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}

export async function removeEntryAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season))) return;
  await removeRankingEntry(String(formData.get("entryId") ?? ""));
  rev(season, String(formData.get("rankingId") ?? ""));
}
