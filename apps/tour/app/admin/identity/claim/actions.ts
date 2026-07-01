"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { getClaimPairs, applyClaims } from "@/lib/services/identity";
import type { ActionResult } from "@/lib/action-result";

// Re-derive the pairs server-side (so the UI can't feed a stale/tampered list) and merge
// each legacy player into its linked account.
export async function applyAllClaimsAction(_prev: ActionResult, _formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  try {
    const pairs = await getClaimPairs();
    if (!pairs.length) return { ok: true, message: "Nothing to claim." };
    const r = await applyClaims(pairs.map((p) => ({ linkedId: p.linkedId, candidateId: p.candidateId })));
    revalidatePath("/admin/identity");
    revalidatePath("/admin/identity/claim");
    revalidatePath("/players");
    return { ok: true, message: `Claimed ${r.merged} account${r.merged === 1 ? "" : "s"}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed." };
  }
}
