"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { resolveDiscordIdToDisplayName } from "@/lib/add-player";
import { announceResult } from "@/lib/announce";
import { addGuildMemberRole } from "@/lib/discord";

// Set a per-division target size override. Null clears the override and
// falls back to Season.targetGroupSize at display time.
export async function setDivisionTargetSize(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const sizeRaw = String(formData.get("targetSize") ?? "").trim();
  if (!divisionId) return;
  const targetSize = sizeRaw === "" ? null : Math.max(1, parseInt(sizeRaw, 10) || 0);
  if (targetSize !== null && Number.isNaN(targetSize)) return;
  await prisma.division.update({
    where: { id: divisionId },
    data: { targetSize },
  });
  revalidatePath(`/admin/divisions/${divisionId}`);
  revalidatePath("/admin/divisions");
  revalidatePath("/admin/seasons");
}

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

// Bulk import: parses a textarea where each non-blank line is a Discord ID
// (17-20 digits — anything else is skipped with a note). For each valid id:
// upsert Player, upsert DivisionMember as ACTIVE, optionally assign role.
// Returns counts via redirect query string.
export async function bulkAddMembers(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const raw = String(formData.get("lines") ?? "");
  if (!divisionId || !raw.trim()) {
    redirect(`/admin/divisions/${divisionId}?err=missing-fields`);
  }
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) redirect(`/admin/divisions/${divisionId}?err=no-guild-id`);

  const division = await prisma.division.findUnique({ where: { id: divisionId } });
  if (!division) redirect(`/admin/divisions/${divisionId}?err=division-not-found`);

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let added = 0;
  let skipped = 0;
  const failedIds: string[] = [];

  for (const line of lines) {
    // Extract first 17-20 digit number from the line (lets users paste mentions like <@123...>)
    const match = line.match(/\d{17,20}/);
    if (!match) {
      skipped++;
      continue;
    }
    const discordId = match[0];
    const resolved = await resolveDiscordIdToDisplayName(guildId, discordId);
    if ("error" in resolved) {
      failedIds.push(discordId);
      continue;
    }
    const player = await prisma.player.upsert({
      where: { discordId: resolved.discordId },
      create: { discordId: resolved.discordId, displayName: resolved.displayName },
      update: { displayName: resolved.displayName },
    });
    await prisma.divisionMember.upsert({
      where: { divisionId_playerId: { divisionId, playerId: player.id } },
      create: { divisionId, playerId: player.id, status: "ACTIVE" },
      update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
    });
    if (division!.discordRoleId) {
      await addGuildMemberRole(guildId, player.discordId, division!.discordRoleId);
    }
    added++;
  }

  const summary = `added=${added}&skipped=${skipped}&failed=${failedIds.join(",")}`;
  revalidatePath(`/admin/divisions/${divisionId}`);
  redirect(`/admin/divisions/${divisionId}?bulk=${encodeURIComponent(summary)}`);
}

// Bulk record played pairings. Each non-blank line has the form:
//   <discordId_or_mention_A> <discordId_or_mention_B> <RESULT>
// where RESULT is 2-0, 1-1, or 0-2 (A vs B). Lines starting with # are skipped.
// Both players must already be members of this division.
export async function bulkRecordPairings(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const raw = String(formData.get("lines") ?? "");
  if (!divisionId || !raw.trim()) {
    redirect(`/admin/divisions/${divisionId}?err=missing-fields`);
  }

  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    include: { members: { include: { player: true } } },
  });
  if (!division) redirect(`/admin/divisions/${divisionId}?err=division-not-found`);

  const memberByDiscordId = new Map(
    division!.members.map((m) => [m.player.discordId, m.player]),
  );

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let recorded = 0;
  const errors: string[] = [];

  for (const line of lines) {
    const ids = [...line.matchAll(/\d{17,20}/g)].map((m) => m[0]);
    const resultMatch = line.match(/\b(2-0|1-1|0-2)\b/);
    if (ids.length < 2 || !resultMatch) {
      errors.push(`bad line: ${line.slice(0, 60)}`);
      continue;
    }
    const [aDiscord, bDiscord] = ids;
    const aPlayer = memberByDiscordId.get(aDiscord!);
    const bPlayer = memberByDiscordId.get(bDiscord!);
    if (!aPlayer || !bPlayer) {
      errors.push(`not in division: ${aPlayer ? bDiscord : aDiscord}`);
      continue;
    }
    if (aPlayer.id === bPlayer.id) {
      errors.push(`same player twice: ${aDiscord}`);
      continue;
    }
    const result = resultMatch[0];
    const games = result === "2-0" ? { a: 2, b: 0 } : result === "0-2" ? { a: 0, b: 2 } : { a: 1, b: 1 };

    const [canonA, canonB] = aPlayer.id < bPlayer.id ? [aPlayer.id, bPlayer.id] : [bPlayer.id, aPlayer.id];
    const aIsCanonA = aPlayer.id === canonA;
    const gamesWonA = aIsCanonA ? games.a : games.b;
    const gamesWonB = aIsCanonA ? games.b : games.a;

    await prisma.pairing.upsert({
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
      },
      update: {
        gamesWonA,
        gamesWonB,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    });
    recorded++;
  }

  const summary = `recorded=${recorded}&errors=${encodeURIComponent(errors.slice(0, 10).join(" | "))}`;
  revalidatePath(`/admin/divisions/${divisionId}`);
  redirect(`/admin/divisions/${divisionId}?bulk=${encodeURIComponent(summary)}`);
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
