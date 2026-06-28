"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth";
import { captainPropose, captainRespond, captainCancelProposal } from "@/lib/services/pairing";
import type { ActionResult } from "@/lib/action-result";

// Captain pairing. The actor is the signed-in viewer's playerId; the service checks
// they actually captain one of the two teams, and the engine enforces turn order +
// the ±2 window — so a captain can only ever act for their own side, in turn.
export async function proposeAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const v = await getViewer();
  if (!v.playerId) return { ok: false, message: "Sign in to pair." };
  const matchupId = String(formData.get("matchupId") ?? "");
  try {
    await captainPropose(matchupId, v.playerId, String(formData.get("playerId") ?? ""));
    revalidatePath(`/matchups/${matchupId}`);
    return { ok: true, message: "Proposed — waiting on the other captain to respond." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Propose failed." };
  }
}

export async function respondAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const v = await getViewer();
  if (!v.playerId) return { ok: false, message: "Sign in to pair." };
  const matchupId = String(formData.get("matchupId") ?? "");
  try {
    await captainRespond(matchupId, v.playerId, String(formData.get("playerId") ?? ""));
    revalidatePath(`/matchups/${matchupId}`);
    return { ok: true, message: "Pair set." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Respond failed." };
  }
}

export async function cancelProposalAction(formData: FormData) {
  const v = await getViewer();
  if (!v.playerId) return;
  const matchupId = String(formData.get("matchupId") ?? "");
  try {
    await captainCancelProposal(matchupId, v.playerId);
  } catch {
    /* nothing pending — ignore */
  }
  revalidatePath(`/matchups/${matchupId}`);
}
