"use server";

// Server action for the admin bulk-resolve queue (/admin/resolve). The
// "Preview" step (toolbar -> confirmation screen) is a plain GET navigation
// handled entirely inside page.tsx -- nothing to mutate there. This is the
// one write: "Apply" on the confirmation screen, which hands the admin's
// selected ids/action/reason to lib/bulk-resolve.ts and redirects back to the
// filtered list with a result flash.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser } from "@/lib/audit";
import { applyBulkResolve, type BulkAction } from "@/lib/bulk-resolve";

const PAGE = "/admin/resolve";

function isBulkAction(value: string): value is BulkAction {
  return value === "void" || value === "forfeit-a" || value === "forfeit-b" || value === "double-forfeit";
}

// Short, readable summary for the ?ok=/?err= flash -- full per-match detail
// already showed on the confirmation screen the admin just approved, so this
// only needs to confirm what happened and surface a sample of any refusals.
function summarize(appliedCount: number, refused: Array<{ id: string; reason: string }>): string {
  const parts = [`Applied to ${appliedCount} match${appliedCount === 1 ? "" : "es"}.`];
  if (refused.length > 0) {
    const sample = [...new Set(refused.map((r) => r.reason))].slice(0, 3);
    const extra = refused.length > sample.length ? ` (and ${refused.length - sample.length} more)` : "";
    parts.push(`${refused.length} refused -- ${sample.join("; ")}${extra}`);
  }
  return parts.join(" ");
}

export async function applyBulkResolveAction(formData: FormData) {
  const { user } = await requireAdmin();
  const ids = [...new Set(formData.getAll("ids").map((v) => String(v).trim()).filter(Boolean))];
  const actionRaw = String(formData.get("action") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const returnToRaw = String(formData.get("returnTo") ?? "").trim();
  const returnTo = returnToRaw.startsWith(PAGE) ? returnToRaw : PAGE;

  if (ids.length === 0 || !isBulkAction(actionRaw)) {
    redirect(`${PAGE}?err=${encodeURIComponent("Select at least one match and an action before applying.")}`);
  }

  const result = await applyBulkResolve({ ids, action: actionRaw, reason, actor: actorFromAdminUser(user) });

  revalidatePath(PAGE);
  const sep = returnTo.includes("?") ? "&" : "?";
  const param = result.applied.length === 0 ? "err" : "ok";
  const msg = summarize(result.applied.length, result.refused);
  redirect(`${returnTo}${sep}${param}=${encodeURIComponent(msg)}`);
}
