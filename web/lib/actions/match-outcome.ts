"use server";

// One server action behind the consolidated "Match actions" panel: pick a
// matchup + an OUTCOME, and this routes to the right canonical mutation in
// match-admin.ts. Replaces the scattered Record / Override / Forfeit / Void /
// Undo forms with a single entry point. Used on both the division page and
// /admin/results (each passes its own returnTo).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { recordResult, voidGame, forfeitResult, undoResult } from "@/lib/match-admin";

export async function setMatchOutcome(formData: FormData) {
  const { user } = await requireAdmin();
  const actor = actorFromAdminUser(user);
  const divisionId = String(formData.get("divisionId") ?? "");
  const p1Id = String(formData.get("p1") ?? "");
  const p2Id = String(formData.get("p2") ?? "");
  const outcome = String(formData.get("outcome") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? `/divisions/${divisionId}`);

  const fail = (msg: string): never => redirect(`${returnTo}?err=${encodeURIComponent(msg)}`);
  if (!divisionId || !p1Id || !p2Id || p1Id === p2Id) fail("Pick a matchup.");
  if ((outcome === "p1-dq" || outcome === "p2-dq") && !reason) fail("A DQ needs a reason.");

  // Optional per-game detail for an outside-the-flow match (game 1 / game 2).
  const lives = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
  };
  const str = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const games = [
    { deck: str("deck1"), stake: str("stake1"), winnerLives: lives("livesGame1") },
    { deck: str("deck2"), stake: str("stake2"), winnerLives: lives("livesGame2") },
  ];

  // p1/p2 are the two picked players; recordResult's result string is relative
  // to playerA, so we pass p1 as A and read the result from p1's perspective.
  let r;
  switch (outcome) {
    case "p1-2-0":
      r = await recordResult({ divisionId, playerAId: p1Id, playerBId: p2Id, result: "2-0", actor, reason: reason || undefined, games, announce: false });
      break;
    case "draw":
      r = await recordResult({ divisionId, playerAId: p1Id, playerBId: p2Id, result: "1-1", actor, reason: reason || undefined, games, announce: false });
      break;
    case "p2-2-0":
      r = await recordResult({ divisionId, playerAId: p1Id, playerBId: p2Id, result: "0-2", actor, reason: reason || undefined, games, announce: false });
      break;
    case "void":
      r = await voidGame({ divisionId, p1Id, p2Id, reason, actor });
      break;
    case "p1-dq":
      r = await forfeitResult({ divisionId, winnerId: p1Id, loserId: p2Id, reason, actor, announce: false });
      break;
    case "p2-dq":
      r = await forfeitResult({ divisionId, winnerId: p2Id, loserId: p1Id, reason, actor, announce: false });
      break;
    case "undo": {
      const [a, b] = p1Id < p2Id ? [p1Id, p2Id] : [p2Id, p1Id];
      const m = await prisma.match.findFirst({
        where: { divisionId, playerAId: a, playerBId: b, format: "LEAGUE_BO2" },
        select: { id: true },
      });
      if (!m) fail("No recorded match to undo for that pair.");
      r = await undoResult({ matchId: m!.id, actor });
      break;
    }
    default:
      fail("Unknown outcome.");
  }

  if (r && !r.ok) fail(r.reason);
  revalidatePath(`/divisions/${divisionId}`);
  revalidatePath("/admin/results");
  redirect(`${returnTo}?ok=match-updated`);
}
