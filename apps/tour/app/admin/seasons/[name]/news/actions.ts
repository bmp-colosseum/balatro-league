"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { createNews, updateNews, deleteNews } from "@/lib/services/news";
import type { ActionResult } from "@/lib/action-result";

function rev(season: string) {
  const enc = encodeURIComponent(season);
  revalidatePath(`/admin/seasons/${enc}/news`);
  revalidatePath(`/seasons/${enc}/news`);
  revalidatePath(`/seasons/${enc}`);
}

const wk = (fd: FormData) => {
  const v = fd.get("week");
  const n = Number(v);
  return v != null && String(v).trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

export async function createNewsAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    await createNews(season, { week: wk(formData), title: String(formData.get("title") ?? ""), body: String(formData.get("body") ?? "") });
    rev(season);
    return { ok: true, message: "Posted." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Post failed." };
  }
}

export async function updateNewsAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const season = String(formData.get("season") ?? "");
  try {
    await updateNews(String(formData.get("id") ?? ""), { week: wk(formData), title: String(formData.get("title") ?? ""), body: String(formData.get("body") ?? "") });
    rev(season);
    return { ok: true, message: "Updated." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Update failed." };
  }
}

export async function deleteNewsAction(formData: FormData) {
  if (!(await isAdmin())) return;
  const season = String(formData.get("season") ?? "");
  await deleteNews(String(formData.get("id") ?? ""));
  rev(season);
}
