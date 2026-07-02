"use server";

import { revalidatePath } from "next/cache";
import { getViewer, isAdmin } from "@/lib/auth";
import { grantCapabilities, revokeGrant } from "@/lib/services/access";
import type { Capability } from "@/lib/permissions";
import type { ActionResult } from "@/lib/action-result";

const CAPS = ["NEWS", "RANKINGS", "ROSTERS", "DRAFT", "SCHEDULE"] as const;

export async function grantAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Not authorized." };
  const subjectType = formData.get("subjectType") === "ROLE" ? "ROLE" : "USER";
  const subjectId = String(formData.get("subjectId") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim() || null;
  const seasonId = String(formData.get("seasonId") ?? "").trim() || null;
  const capabilities = formData.getAll("capability").map((c) => String(c)).filter((c): c is Capability => (CAPS as readonly string[]).includes(c));
  try {
    const by = (await getViewer()).discordId;
    await grantCapabilities({ subjectType, subjectId, label, capabilities, seasonId, by });
    revalidatePath("/admin/access");
    return { ok: true, message: `Granted ${capabilities.join(", ")}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Grant failed." };
  }
}

export async function revokeAction(formData: FormData) {
  if (!(await isAdmin())) return;
  await revokeGrant(String(formData.get("id") ?? ""));
  revalidatePath("/admin/access");
}
