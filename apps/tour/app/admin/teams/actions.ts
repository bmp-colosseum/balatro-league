"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { deleteTeamSeason } from "@/lib/services/teams-admin";
import type { ActionResult } from "@/lib/action-result";

export async function deleteTeamAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  try {
    const r = await deleteTeamSeason(String(formData.get("teamSeasonId") ?? ""));
    revalidatePath("/admin/teams");
    revalidatePath("/teams");
    return { ok: true, message: `Deleted ${r.team}${r.setsDeleted ? ` (+${r.setsDeleted} sets)` : ""}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Delete failed." };
  }
}
