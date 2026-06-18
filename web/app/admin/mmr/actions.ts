"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { seedMissingMmrFromBmp, setPlayerMmr } from "@/lib/mmr-admin";

export async function fillMissingMmr() {
  await requireAdmin();
  await seedMissingMmrFromBmp();
  revalidatePath("/admin/mmr");
}

// Bulk-save: the form submits one `mmr:<playerId>` field per row. Blank clears
// it (back to unset); a number sets it. Only writes rows that actually changed
// is overkill here — just upsert each provided value.
export async function saveMmrs(formData: FormData) {
  await requireAdmin();
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("mmr:")) continue;
    const playerId = key.slice(4);
    const str = String(raw).trim();
    if (str === "") {
      await setPlayerMmr(playerId, null);
      continue;
    }
    const n = Number.parseInt(str, 10);
    if (Number.isFinite(n)) await setPlayerMmr(playerId, Math.max(0, n));
  }
  revalidatePath("/admin/mmr");
}
