"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { linkPlayer, mergePlayers, applyIdentityRecovery } from "@/lib/services/identity";
import type { ActionResult } from "@/lib/action-result";

export async function linkPlayerAction(playerId: string, discordId: string): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  try {
    await linkPlayer(playerId, discordId);
    revalidatePath("/admin/identity");
    return { ok: true, message: "Linked." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Link failed." };
  }
}

export async function mergePlayerAction(keepId: string, dropId: string): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  try {
    const r = await mergePlayers(keepId, dropId);
    revalidatePath("/admin/identity");
    return { ok: true, message: `Merged ${r.dropped} into ${r.keep}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Merge failed." };
  }
}

// Apply the duplicate-recovery plan. `pairs` is a JSON array of {keepId,dropId}
// (the currently-displayed plan); applyIdentityRecovery re-derives + validates it.
export async function applyRecoveryAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  try {
    const pairs = JSON.parse(String(formData.get("pairs") ?? "[]")) as { keepId: string; dropId: string }[];
    if (!pairs.length) return { ok: false, message: "Nothing to recover." };
    const r = await applyIdentityRecovery(pairs);
    revalidatePath("/admin/identity");
    revalidatePath("/admin/identity/recover");
    const errs = r.errors.length ? ` (${r.errors.length} skipped)` : "";
    return { ok: true, message: `Recovered ${r.merged} duplicate${r.merged === 1 ? "" : "s"}${errs}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Recovery failed." };
  }
}
