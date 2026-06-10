"use server";

// Server actions for the central /admin/results page. Thin wrappers over the
// shared match-admin module — auth + parse + redirect back to the division.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser } from "@/lib/audit";
import {
  recordResult,
  overrideResult,
  forfeitResult,
  recordShowdown,
  undoResult,
  type ResultStr,
} from "@/lib/match-admin";

const RESULTS = ["2-0", "1-1", "0-2"];

function back(divisionId: string, msg: string): never {
  revalidatePath("/admin/results");
  revalidatePath(`/divisions/${divisionId}`);
  const q = new URLSearchParams();
  if (divisionId) q.set("division", divisionId);
  q.set("ok", msg);
  redirect(`/admin/results?${q.toString()}`);
}

export async function recordResultAction(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerAId = String(formData.get("playerAId") ?? "");
  const playerBId = String(formData.get("playerBId") ?? "");
  const result = String(formData.get("result") ?? "") as ResultStr;
  if (divisionId && playerAId && playerBId && RESULTS.includes(result)) {
    await recordResult({ divisionId, playerAId, playerBId, result, actor: actorFromAdminUser(user) });
  }
  back(divisionId, "recorded");
}

export async function overrideResultAction(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const matchId = String(formData.get("matchId") ?? "");
  const result = String(formData.get("result") ?? "") as ResultStr;
  if (matchId && RESULTS.includes(result)) {
    await overrideResult({ matchId, result, actor: actorFromAdminUser(user) });
  }
  back(divisionId, "overridden");
}

export async function forfeitAction(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const winnerId = String(formData.get("winnerId") ?? "");
  const loserId = String(formData.get("loserId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (divisionId && winnerId && loserId && reason) {
    await forfeitResult({ divisionId, winnerId, loserId, reason, actor: actorFromAdminUser(user) });
  }
  back(divisionId, "forfeit");
}

export async function showdownAction(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const p1Id = String(formData.get("p1Id") ?? "");
  const p2Id = String(formData.get("p2Id") ?? "");
  const winnerId = String(formData.get("winnerId") ?? "");
  if (divisionId && p1Id && p2Id && winnerId) {
    await recordShowdown({ divisionId, p1Id, p2Id, winnerId, actor: actorFromAdminUser(user) });
  }
  back(divisionId, "showdown");
}

export async function undoAction(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const matchId = String(formData.get("matchId") ?? "");
  if (matchId) {
    await undoResult({ matchId, actor: actorFromAdminUser(user) });
  }
  back(divisionId, "undone");
}
