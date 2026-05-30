"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { announceResult } from "@/lib/announce";

type Result = "2-0" | "1-1" | "0-2";

function gamesFromResult(r: Result): { a: number; b: number } {
  if (r === "2-0") return { a: 2, b: 0 };
  if (r === "0-2") return { a: 0, b: 2 };
  return { a: 1, b: 1 };
}

export async function recordSet(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerAId = String(formData.get("playerAId") ?? "");
  const playerBId = String(formData.get("playerBId") ?? "");
  const result = String(formData.get("result") ?? "") as Result;
  if (!divisionId || !playerAId || !playerBId || !["2-0", "1-1", "0-2"].includes(result)) return;

  const [canonA, canonB] = playerAId < playerBId ? [playerAId, playerBId] : [playerBId, playerAId];
  const meIsA = playerAId === canonA;
  const games = gamesFromResult(result);
  const gamesWonA = meIsA ? games.a : games.b;
  const gamesWonB = meIsA ? games.b : games.a;

  const recorded = await prisma.pairing.upsert({
    where: { divisionId_playerAId_playerBId: { divisionId, playerAId: canonA, playerBId: canonB } },
    create: {
      divisionId,
      playerAId: canonA,
      playerBId: canonB,
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      reportedAt: new Date(),
      confirmedAt: new Date(),
      adminOverrideBy: "web-dashboard",
      adminOverrideReason: "recorded via web dashboard",
    },
    update: {
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: "web-dashboard",
      adminOverrideReason: "recorded via web dashboard (overwrite)",
    },
  });
  // Fire-and-forget Discord announce
  announceResult(recorded.id).catch((err) => console.warn("announceResult failed:", err));
  revalidatePath(`/admin/divisions/${divisionId}`);
}

export async function overridePairing(formData: FormData) {
  await requireAdmin();
  const pairingId = String(formData.get("pairingId") ?? "");
  const result = String(formData.get("result") ?? "") as Result;
  if (!pairingId || !["2-0", "1-1", "0-2"].includes(result)) return;
  const games = gamesFromResult(result);
  const updated = await prisma.pairing.update({
    where: { id: pairingId },
    data: {
      gamesWonA: games.a,
      gamesWonB: games.b,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: "web-dashboard",
      adminOverrideReason: "override via web dashboard",
    },
  });
  announceResult(updated.id).catch((err) => console.warn("announceResult failed:", err));
  revalidatePath(`/admin/divisions/${updated.divisionId}`);
}

export async function deletePairing(formData: FormData) {
  await requireAdmin();
  const pairingId = String(formData.get("pairingId") ?? "");
  if (!pairingId) return;
  const p = await prisma.pairing.findUnique({ where: { id: pairingId } });
  if (!p) return;
  await prisma.pairing.delete({ where: { id: pairingId } });
  revalidatePath(`/admin/divisions/${p.divisionId}`);
}
