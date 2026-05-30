"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { resolveDiscordIdToDisplayName } from "@/lib/add-player";
import { announceResult } from "@/lib/announce";
import { addGuildMemberRole } from "@/lib/discord";

// Mid-season add: upsert Player by Discord ID, add to division as ACTIVE.
// If the division has a discordRoleId, also assign the role so they get
// access to the division's private channel.
export async function addDivisionMemberByDiscordId(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const discordIdRaw = String(formData.get("discordId") ?? "");
  const displayNameOverride = String(formData.get("displayName") ?? "").trim();
  if (!divisionId || !discordIdRaw) {
    redirect(`/admin/divisions/${divisionId}?err=missing-fields`);
  }
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) redirect(`/admin/divisions/${divisionId}?err=no-guild-id`);

  const resolved = await resolveDiscordIdToDisplayName(guildId, discordIdRaw);
  if ("error" in resolved) {
    redirect(`/admin/divisions/${divisionId}?err=${encodeURIComponent(resolved.error)}`);
  }

  const player = await prisma.player.upsert({
    where: { discordId: resolved.discordId },
    create: { discordId: resolved.discordId, displayName: displayNameOverride || resolved.displayName },
    update: { displayName: displayNameOverride || resolved.displayName },
  });

  await prisma.divisionMember.upsert({
    where: { divisionId_playerId: { divisionId, playerId: player.id } },
    create: { divisionId, playerId: player.id, status: "ACTIVE" },
    update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
  });

  const division = await prisma.division.findUnique({ where: { id: divisionId } });
  if (division?.discordRoleId) {
    await addGuildMemberRole(guildId, player.discordId, division.discordRoleId);
  }

  revalidatePath(`/admin/divisions/${divisionId}`);
}

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
