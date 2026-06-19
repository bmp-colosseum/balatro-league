"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser } from "@/lib/audit";
import { buildSeasonFromContinuity } from "@/lib/build-season-continuity";

// Commit the "Based on current season" preview — including any hand-moves the
// admin made in the editable view — as a real DRAFT season. Redirects to the
// season detail page (draft mode) where it's reviewed and activated, same as
// the normal build flow.
export async function buildContinuitySeason(formData: FormData) {
  const { user } = await requireAdmin();

  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;

  let moves: Record<string, number> = {};
  try {
    const parsed = JSON.parse(String(formData.get("moves") ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        const n = Number(v);
        if (Number.isInteger(n)) moves[k] = n;
      }
    }
  } catch {
    // Bad JSON → no overrides, just build the algorithm's arrangement.
  }

  const subtitleRaw = String(formData.get("subtitle") ?? "").trim();

  const result = await buildSeasonFromContinuity({
    roundId,
    moves,
    subtitle: subtitleRaw.length > 0 ? subtitleRaw : null,
    actor: actorFromAdminUser(user),
  });

  if (result === "NO_SEASON") redirect(`/admin/signups/${roundId}/preview?basis=current&err=no-season`);
  if (result === "ALREADY_BUILT") redirect(`/admin/signups/${roundId}/preview?basis=current&err=already-built`);
  if (!result) redirect(`/admin/signups/${roundId}/preview?basis=current&err=build-failed`);

  revalidatePath("/admin/signups");
  revalidatePath("/admin/seasons");
  // Land straight on the editable arrange page — drag players, autosave, activate.
  redirect(`/admin/signups/${roundId}/arrange`);
}
