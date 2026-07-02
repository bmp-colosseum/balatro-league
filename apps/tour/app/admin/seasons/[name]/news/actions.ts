"use server";

import { revalidatePath } from "next/cache";
import { can, seasonIdByName } from "@/lib/permissions";
import { createNews, updateNews, deleteNews } from "@/lib/services/news";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/news`);
  revalidatePath(`/seasons/${enc}/news`);
  revalidatePath(`/seasons/${enc}`);
}

// NEWS capability (or TO), scoped to the season being edited.
const allow = async (season: string) => can("NEWS", { seasonId: await seasonIdByName(season) });

const wk = (fd: FormData) => {
  const v = fd.get("week");
  const n = Number(v);
  return v != null && String(v).trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

// A "YYYY-MM-DD" date input -> local-noon Date (noon avoids day-shifting across timezones).
// Empty means "leave the current/default date" (null → service skips the field).
const postedAt = (fd: FormData): Date | null => {
  const v = String(fd.get("postedAt") ?? "").trim();
  if (!v) return null;
  const d = new Date(`${v}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function createNewsAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season))) return { ok: false, message: "Not authorized." };
  try {
    await createNews(season, { week: wk(formData), title: String(formData.get("title") ?? ""), body: String(formData.get("body") ?? ""), postedAt: postedAt(formData) });
    rev(season);
    return { ok: true, message: "Posted." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Post failed." };
  }
}

export async function updateNewsAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season))) return { ok: false, message: "Not authorized." };
  try {
    await updateNews(String(formData.get("id") ?? ""), { week: wk(formData), title: String(formData.get("title") ?? ""), body: String(formData.get("body") ?? ""), postedAt: postedAt(formData) });
    rev(season);
    return { ok: true, message: "Updated." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Update failed." };
  }
}

export async function deleteNewsAction(formData: FormData) {
  const season = String(formData.get("season") ?? "");
  if (!(await allow(season))) return;
  await deleteNews(String(formData.get("id") ?? ""));
  rev(season);
}
