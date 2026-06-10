"use server";

// Server actions for /admin/players. Called from forms.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { enqueueAnnounceResult, enqueueMmrSnapshot } from "@/lib/queue";
import { placePlayerInDivision } from "@/lib/division-membership";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { actorFromAdminUser } from "@/lib/audit";
import { recordResult, forfeitResult } from "@/lib/match-admin";

type Result = "2-0" | "1-1" | "0-2";

// Change a player's Discord ID. Useful when a row was imported with a
// typo or the wrong account ID. Keeps everything else (rating, memberships,
// pairings) intact — they all reference Player.id, not discordId.
export async function setPlayerDiscordId(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const newId = String(formData.get("discordId") ?? "").trim();
  if (!playerId || !newId) return;
  if (!/^\d{17,20}$/.test(newId)) return;

  // Check the new ID isn't already in use by another player
  const collision = await prisma.player.findUnique({ where: { discordId: newId } });
  if (collision && collision.id !== playerId) return; // silently no-op on collision

  await prisma.player.update({
    where: { id: playerId },
    // Also clear the custom-name flag so the next /me visit auto-syncs the
    // new account's actual Discord username (probably what admin wants).
    data: { discordId: newId, hasCustomDisplayName: false },
  });
  revalidatePath("/admin/players");
}

// Admin records a set between two active members of a division. Upserts
// the Pairing as CONFIRMED with this admin's user id stamped on
// adminOverrideBy. Mirrors /admin/divisions/[id] recordSet but invocable
// from the per-player view so admin doesn't have to navigate away.
export async function recordSetForPlayer(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  const opponentId = String(formData.get("opponentId") ?? "");
  const result = String(formData.get("result") ?? "") as Result;
  if (!["2-0", "1-1", "0-2"].includes(result)) return;
  await recordResult({ divisionId, playerAId: playerId, playerBId: opponentId, result, actor: actorFromAdminUser(user) });
  revalidatePath("/admin/players");
  revalidatePath(`/divisions/${divisionId}`);
}

// Award a 2-0 win by forfeit / DQ between this player and an opponent. Same
// upsert as recordSetForPlayer, but forces 2-0 to the chosen winner and flags
// the match as a forfeit. `reason` is admin-only (stored on forfeitReason +
// audit) — never shown to other players; the public UI only shows "by DQ".
export async function recordForfeitForPlayer(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  const opponentId = String(formData.get("opponentId") ?? "");
  const side = String(formData.get("winner") ?? ""); // "self" | "opponent"
  const reason = String(formData.get("reason") ?? "").trim();
  if (side !== "self" && side !== "opponent") return;
  const winnerId = side === "self" ? playerId : opponentId;
  const loserId = side === "self" ? opponentId : playerId;
  await forfeitResult({ divisionId, winnerId, loserId, reason, actor: actorFromAdminUser(user) });
  revalidatePath("/admin/players");
  revalidatePath(`/divisions/${divisionId}`);
}

const MOCK_PREFIX = "mock-";

export async function addFakePlayer(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const divisionId = String(formData.get("divisionId") ?? "").trim();
  if (!name) return;

  const discordId = `${MOCK_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const player = await prisma.player.create({
    data: { discordId, displayName: name },
  });

  if (divisionId) {
    // No size gate — admin add-flow respects the admin's intent.
    // Division size is whatever's in it, not a configured limit.
    const div = await prisma.division.findUnique({ where: { id: divisionId } });
    if (div) await placePlayerInDivision(div.id, player.id);
  }
  revalidatePath("/admin/players");
}

// Move a player into/out of a division. divisionId encodes which season,
// so this works for any season (not just the active one). Empty divisionId
// = remove from whatever division(s) they're in for that season.
//
// placePlayerInDivision handles the "in any other division this season"
// case automatically (transfers them).
export async function movePlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const divisionId = String(formData.get("divisionId") ?? "").trim();
  if (!playerId) return;

  if (divisionId) {
    // No size gate — see createMockPlayer comment. Division "target
    // size" is informational, not a hard cap on placement.
    const div = await prisma.division.findUnique({ where: { id: divisionId } });
    if (!div) return;
    await placePlayerInDivision(div.id, playerId);
  } else {
    // Empty divisionId = remove from active season (preserves old behavior for the "— remove —" option)
    const active = await prisma.season.findFirst({ where: { isActive: true } });
    if (active) {
      await prisma.divisionMember.deleteMany({
        where: { playerId, division: { seasonId: active.id } },
      });
    }
  }
  revalidatePath("/admin/players");
}

export async function dropPlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season || !playerId) return;

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId: season.id }, status: "ACTIVE" },
  });
  if (!membership) return;

  await prisma.divisionMember.update({
    where: { id: membership.id },
    data: { status: "DROPPED", droppedAt: new Date() },
  });

  // Void unplayed pairings
  await prisma.match.deleteMany({
    where: {
      divisionId: membership.divisionId,
      status: "PENDING",
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  recomputeDivisionStandings(membership.divisionId).catch(() => {});
  revalidatePath("/admin/players");
}

export async function reinstatePlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  const season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season || !playerId) return;

  const membership = await prisma.divisionMember.findFirst({
    where: { playerId, division: { seasonId: season.id }, status: "DROPPED" },
  });
  if (membership) {
    await prisma.divisionMember.update({
      where: { id: membership.id },
      data: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
    });
  }
  revalidatePath("/admin/players");
}

export async function deletePlayer(formData: FormData) {
  await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "");
  if (!playerId) return;
  // Collect affected divisions before the delete so we can recompute
  // each one's standings after the player's pairings vanish.
  const affected = await prisma.match.findMany({
    where: { OR: [{ playerAId: playerId }, { playerBId: playerId }] },
    select: { divisionId: true },
    distinct: ["divisionId"],
  });
  await prisma.match.deleteMany({
    where: { OR: [{ playerAId: playerId }, { playerBId: playerId }] },
  });
  await prisma.player.delete({ where: { id: playerId } });
  for (const { divisionId } of affected) {
    recomputeDivisionStandings(divisionId).catch(() => {});
  }
  revalidatePath("/admin/players");
}

// Manual trigger for the same fanout the daily cron does — enqueue a
// fresh BMP MMR snapshot for every active-season member. Same scope as
// the 12:00 UTC cron in src/queue.ts: past-season players aren't
// refreshed because their snapshots are historical and immutable.
export async function refreshActiveSeasonMmrs() {
  await requireAdmin();
  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true, endedAt: null },
    orderBy: { startedAt: "desc" },
    include: {
      divisions: {
        include: {
          members: {
            where: { status: "ACTIVE" },
            include: { player: { select: { discordId: true } } },
          },
        },
      },
    },
  });
  if (!activeSeason) return;
  const seen = new Set<string>();
  for (const div of activeSeason.divisions) {
    for (const m of div.members) {
      if (seen.has(m.player.discordId)) continue;
      seen.add(m.player.discordId);
      await enqueueMmrSnapshot({ discordId: m.player.discordId, seasonId: activeSeason.id }).catch(
        (err) => console.warn(`[admin-refresh-mmr] enqueue failed for ${m.player.discordId}:`, err),
      );
    }
  }
  console.log(`[admin-refresh-mmr] queued ${seen.size} for active season ${activeSeason.id}`);
  revalidatePath("/admin/players");
}
