"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { resolveDiscordIdToDisplayName } from "@/lib/add-player";
import { enqueueAnnounceResult } from "@/lib/queue";
import { addGuildMemberRole } from "@/lib/discord";
import { placePlayerInDivision } from "@/lib/division-membership";
import { recomputeDivisionStandings } from "@/lib/standings-cache";

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

  const placement = await placePlayerInDivision(divisionId, player.id);

  const division = await prisma.division.findUnique({ where: { id: divisionId } });
  if (division?.discordRoleId) {
    await addGuildMemberRole(guildId, player.discordId, division.discordRoleId);
  }

  revalidatePath(`/admin/divisions/${divisionId}`);
  if (placement.transferred) {
    redirect(`/admin/divisions/${divisionId}?bulk=${encodeURIComponent(`transferred=${encodeURIComponent(player.displayName)}&from=${encodeURIComponent(placement.previousDivisionName ?? "")}`)}`);
  }
}

// Soft drop: marks the membership DROPPED and voids any PENDING pairings.
// Played (CONFIRMED) pairings stay so standings reflect actual play history.
export async function dropDivisionMember(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  if (!divisionId || !playerId) return;

  const membership = await prisma.divisionMember.findUnique({
    where: { divisionId_playerId: { divisionId, playerId } },
  });
  if (!membership) return;

  await prisma.divisionMember.update({
    where: { id: membership.id },
    data: { status: "DROPPED", droppedAt: new Date() },
  });
  // Void unplayed pairings only
  await prisma.pairing.deleteMany({
    where: {
      divisionId,
      status: "PENDING",
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  recomputeDivisionStandings(divisionId).catch(() => {});
  revalidatePath(`/admin/divisions/${divisionId}`);
}

// Reverse of dropDivisionMember.
export async function reactivateDivisionMember(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  if (!divisionId || !playerId) return;
  await prisma.divisionMember.update({
    where: { divisionId_playerId: { divisionId, playerId } },
    data: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
  });
  revalidatePath(`/admin/divisions/${divisionId}`);
}

// Hard remove: deletes the membership entirely + ALL pairings in this
// division involving the player (both played and unplayed). Use for
// "added by mistake" cases, not for normal mid-season dropouts (use
// drop for that). If the division has a Discord role, the player is
// NOT auto-removed from the role — that's manual since they may want
// to keep channel access for chat history.
export async function removeDivisionMember(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  if (!divisionId || !playerId) return;

  await prisma.pairing.deleteMany({
    where: {
      divisionId,
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  await prisma.divisionMember.deleteMany({
    where: { divisionId, playerId },
  });
  recomputeDivisionStandings(divisionId).catch(() => {});
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
  const transferred: string[] = [];

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
    const placement = await placePlayerInDivision(divisionId, player.id);
    if (placement.transferred) {
      transferred.push(`${player.displayName} (from ${placement.previousDivisionName})`);
    }
    if (division!.discordRoleId) {
      await addGuildMemberRole(guildId, player.discordId, division!.discordRoleId);
    }
    added++;
  }

  const summary = `added=${added}&skipped=${skipped}&failed=${failedIds.join(",")}&transferred=${encodeURIComponent(transferred.slice(0, 10).join(" | "))}`;
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

  // Bulk-record affected exactly one division (the form's divisionId).
  // One recompute at the end is enough.
  recomputeDivisionStandings(divisionId).catch(() => {});

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
  enqueueAnnounceResult(recorded.id).catch((err) => console.warn("announceResult failed:", err));
  recomputeDivisionStandings(divisionId).catch(() => {});
  revalidatePath(`/admin/divisions/${divisionId}`);
}

// Set a single crosstable cell. rowPlayerId is the row in the matrix
// (the player whose games-won is being entered), colPlayerId is the
// column (the opponent). gamesWon is 0/1/2 from row's perspective.
// Mirror cell is auto-derived as (2 - gamesWon) assuming BO2.
// Upserts the Pairing as CONFIRMED with admin-override attribution.
export async function setCrosstableCell(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const rowPlayerId = String(formData.get("rowPlayerId") ?? "");
  const colPlayerId = String(formData.get("colPlayerId") ?? "");
  const gamesWonRaw = String(formData.get("gamesWon") ?? "");
  if (!divisionId || !rowPlayerId || !colPlayerId || rowPlayerId === colPlayerId) return;
  const gamesWon = parseInt(gamesWonRaw, 10);
  if (!Number.isFinite(gamesWon) || gamesWon < 0 || gamesWon > 2) return;

  // Canonical pair ordering — Pairing rows have (A, B) where A < B.
  const [canonA, canonB] = rowPlayerId < colPlayerId ? [rowPlayerId, colPlayerId] : [colPlayerId, rowPlayerId];
  const rowIsA = rowPlayerId === canonA;
  const gamesWonA = rowIsA ? gamesWon : 2 - gamesWon;
  const gamesWonB = rowIsA ? 2 - gamesWon : gamesWon;

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
      adminOverrideReason: "crosstable cell edit",
    },
    update: {
      gamesWonA,
      gamesWonB,
      status: "CONFIRMED",
      confirmedAt: new Date(),
      adminOverrideBy: "web-dashboard",
      adminOverrideReason: "crosstable cell edit (overwrite)",
    },
  });
  // Fire-and-forget Discord announce — same pattern as recordSet and
  // overridePairing. Resolves season-webhook -> LeagueConfig -> env,
  // posts the result. Failure here doesn't block the cell save.
  enqueueAnnounceResult(recorded.id).catch((err) => console.warn("[crosstable cell] announceResult failed:", err));
  recomputeDivisionStandings(divisionId).catch(() => {});
  revalidatePath(`/admin/divisions/${divisionId}`);
}

// Clear a crosstable cell — deletes the Pairing entirely so the cell
// goes back to unplayed. Less common than setting, exposed separately
// so a blank input doesn't silently delete.
export async function clearCrosstableCell(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const rowPlayerId = String(formData.get("rowPlayerId") ?? "");
  const colPlayerId = String(formData.get("colPlayerId") ?? "");
  if (!divisionId || !rowPlayerId || !colPlayerId) return;
  const [canonA, canonB] = rowPlayerId < colPlayerId ? [rowPlayerId, colPlayerId] : [colPlayerId, rowPlayerId];
  await prisma.pairing.deleteMany({
    where: { divisionId, playerAId: canonA, playerBId: canonB },
  });
  recomputeDivisionStandings(divisionId).catch(() => {});
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
  enqueueAnnounceResult(updated.id).catch((err) => console.warn("announceResult failed:", err));
  recomputeDivisionStandings(updated.divisionId).catch(() => {});
  revalidatePath(`/admin/divisions/${updated.divisionId}`);
}

// Record (or overwrite) a shootout result for two members in this
// division. Mirrors the bot's /admin record-shootout flow but server-
// side via a form action. Canonical player ordering matches the
// Pairing convention so the unique constraint catches duplicates.
export async function recordShootout(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const p1Id = String(formData.get("p1") ?? "");
  const p2Id = String(formData.get("p2") ?? "");
  const winnerId = String(formData.get("winnerId") ?? "");
  if (!divisionId || !p1Id || !p2Id || !winnerId) return;
  if (p1Id === p2Id) return;
  if (winnerId !== p1Id && winnerId !== p2Id) return;
  const [canonA, canonB] = p1Id < p2Id ? [p1Id, p2Id] : [p2Id, p1Id];
  await prisma.shootout.upsert({
    where: {
      divisionId_playerAId_playerBId: { divisionId, playerAId: canonA, playerBId: canonB },
    },
    create: { divisionId, playerAId: canonA, playerBId: canonB, winnerId, recordedBy: "web-dashboard" },
    update: { winnerId, recordedBy: "web-dashboard" },
  });
  recomputeDivisionStandings(divisionId).catch(() => {});
  revalidatePath(`/admin/divisions/${divisionId}`);
}

// Remove a shootout — sort falls back to the next tiebreaker (wins,
// draws, alphabetical). Useful when an admin records a wrong winner.
export async function deleteShootout(formData: FormData) {
  await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const p1Id = String(formData.get("p1") ?? "");
  const p2Id = String(formData.get("p2") ?? "");
  if (!divisionId || !p1Id || !p2Id) return;
  const [canonA, canonB] = p1Id < p2Id ? [p1Id, p2Id] : [p2Id, p1Id];
  await prisma.shootout.deleteMany({
    where: { divisionId, playerAId: canonA, playerBId: canonB },
  });
  recomputeDivisionStandings(divisionId).catch(() => {});
  revalidatePath(`/admin/divisions/${divisionId}`);
}

export async function deletePairing(formData: FormData) {
  await requireAdmin();
  const pairingId = String(formData.get("pairingId") ?? "");
  if (!pairingId) return;
  const p = await prisma.pairing.findUnique({ where: { id: pairingId } });
  if (!p) return;
  await prisma.pairing.delete({ where: { id: pairingId } });
  recomputeDivisionStandings(p.divisionId).catch(() => {});
  revalidatePath(`/admin/divisions/${p.divisionId}`);
}
