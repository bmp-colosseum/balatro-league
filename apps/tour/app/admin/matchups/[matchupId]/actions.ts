"use server";

import { revalidatePath } from "next/cache";
import { can, matchupScope } from "@/lib/permissions";
import { makePair, overridePair, setSendFirst, removePair, resetPairing, reassignSetPlayer, setSetBestOf } from "@/lib/services/pairing";
import { reportSet, unreportSet, forfeitSet, dqSet } from "@/lib/services/report";
import type { ActionResult } from "@/lib/action-result";

function rev(matchupId: string) {
  revalidatePath(`/admin/matchups/${matchupId}`);
}

// SCHEDULE capability (or TO), or the captain of either team in this matchup.
const allow = async (matchupId: string) => {
  const { seasonId, teamSeasonIds } = await matchupScope(matchupId);
  return can("SCHEDULE", { seasonId, teamSeasonId: teamSeasonIds });
};

export async function makePairAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return { ok: false, message: "Not authorized." };
  const proposer = String(formData.get("proposerPlayerId") ?? "");
  const responder = String(formData.get("responderPlayerId") ?? "");
  try {
    const r = await makePair(matchupId, proposer, responder);
    rev(matchupId);
    return { ok: true, message: `Pair ${r.pairs} set.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Pairing failed." };
  }
}

export async function overridePairAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return { ok: false, message: "Not authorized." };
  const a = String(formData.get("aPlayerId") ?? "");
  const b = String(formData.get("bPlayerId") ?? "");
  try {
    await overridePair(matchupId, a, b);
    rev(matchupId);
    return { ok: true, message: "Pairing created." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not create the pairing." };
  }
}

export async function setSendFirstAction(formData: FormData) {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return;
  const team = formData.get("team") === "B" ? "B" : "A";
  await setSendFirst(matchupId, team);
  rev(matchupId);
}

export async function removePairAction(formData: FormData) {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return;
  const setId = String(formData.get("setId") ?? "");
  await removePair(setId);
  rev(matchupId);
}

export async function resetPairingAction(formData: FormData) {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return;
  await resetPairing(matchupId);
  rev(matchupId);
}

export async function reportSetAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return { ok: false, message: "Not authorized." };
  const setId = String(formData.get("setId") ?? "");
  const a = Number(formData.get("gamesA"));
  const b = Number(formData.get("gamesB"));
  try {
    await reportSet(setId, a, b);
    rev(matchupId);
    return { ok: true, message: "Result recorded." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Report failed." };
  }
}

export async function unreportSetAction(formData: FormData) {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return;
  const setId = String(formData.get("setId") ?? "");
  await unreportSet(setId);
  rev(matchupId);
}

export async function forfeitSetAction(formData: FormData) {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return;
  const setId = String(formData.get("setId") ?? "");
  const team = formData.get("forfeitTeam") === "B" ? "B" : "A";
  await forfeitSet(setId, team);
  rev(matchupId);
}

// Double DQ -- nobody played, 0-0, no winner; the set counts as accounted-for.
export async function dqSetAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return { ok: false, message: "Not authorized." };
  const setId = String(formData.get("setId") ?? "");
  try {
    await dqSet(setId);
    rev(matchupId);
    return { ok: true, message: "Set recorded as a double DQ (0-0, nobody played)." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "DQ failed." };
  }
}

// Edit a set's best-of in place (e.g. fix sets created under the wrong season default).
export async function setBestOfAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return { ok: false, message: "Not authorized." };
  const setId = String(formData.get("setId") ?? "");
  try {
    const r = await setSetBestOf(setId, Number(formData.get("bestOf")));
    rev(matchupId);
    return { ok: true, message: `Set is now Bo${r.bestOf}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not change best-of." };
  }
}

export async function reassignSetAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const matchupId = String(formData.get("matchupId") ?? "");
  if (!(await allow(matchupId))) return { ok: false, message: "Not authorized." };
  const setId = String(formData.get("setId") ?? "");
  const side = formData.get("side") === "B" ? "B" : "A";
  const inPlayerId = String(formData.get("inPlayerId") ?? "");
  try {
    await reassignSetPlayer(setId, side, inPlayerId);
    rev(matchupId);
    return { ok: true, message: "Set reassigned to the substitute." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Reassign failed." };
  }
}
