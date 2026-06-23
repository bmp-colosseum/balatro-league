"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { reportSetFromWeb } from "@/lib/report";
import { parseReportForm } from "@/lib/report-form";
import { recordResult, forfeitResult, recordShowdown, resolveTieWithShowdowns, undoResult, voidGame, voidPlayerInDivision } from "@/lib/match-admin";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { resolveDiscordIdToDisplayName } from "@/lib/add-player";
import { addGuildMemberRole } from "@/lib/discord";
import { placePlayerInDivision } from "@/lib/division-membership";

// Report a match from the public division page. Same backend as /me
// and /profile dropdowns; redirect lands you back on the division.
export async function reportFromDivisionAction(formData: FormData) {
  const session = await auth();
  const discordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  const divisionId = String(formData.get("divisionId") ?? "");
  if (!discordId) redirect(`/divisions/${divisionId}?reportErr=not-logged-in`);
  const { opponentId, result, deck, stake, lives, valid } = parseReportForm(formData);
  if (!valid) redirect(`/divisions/${divisionId}?reportErr=missing-fields`);
  const r = await reportSetFromWeb(discordId!, opponentId, result, { deck, stake }, lives);
  if (!r.ok) redirect(`/divisions/${divisionId}?reportErr=${encodeURIComponent(r.reason)}`);
  revalidatePath(`/divisions/${divisionId}`);
  revalidatePath("/standings");
  revalidatePath("/me");
  redirect(`/divisions/${divisionId}?reportOk=1`);
}

// ─── Admin actions (moved from /admin/divisions/[id]/actions.ts) ─────

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
  revalidatePath(`/divisions/${divisionId}`);
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
    redirect(`/divisions/${divisionId}?err=missing-fields`);
  }
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) redirect(`/divisions/${divisionId}?err=no-guild-id`);

  const resolved = await resolveDiscordIdToDisplayName(guildId, discordIdRaw);
  if ("error" in resolved) {
    redirect(`/divisions/${divisionId}?err=${encodeURIComponent(resolved.error)}`);
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

  revalidatePath(`/divisions/${divisionId}`);
  if (placement.transferred) {
    redirect(`/divisions/${divisionId}?bulk=${encodeURIComponent(`transferred=${encodeURIComponent(player.displayName)}&from=${encodeURIComponent(placement.previousDivisionName ?? "")}`)}`);
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
  await prisma.match.deleteMany({
    where: {
      divisionId,
      status: "PENDING",
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  await recomputeDivisionStandings(divisionId).catch(() => {});
  revalidatePath(`/divisions/${divisionId}`);
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
  revalidatePath(`/divisions/${divisionId}`);
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

  await prisma.match.deleteMany({
    where: {
      divisionId,
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
  });
  await prisma.divisionMember.deleteMany({
    where: { divisionId, playerId },
  });
  await recomputeDivisionStandings(divisionId).catch(() => {});
  revalidatePath(`/divisions/${divisionId}`);
}

type Result = "2-0" | "1-1" | "0-2";

// Admin "record a result" action
// (which is for the public per-row report form). This is for the admin's
// "Matches — unplayed" picker that lets them set any unplayed pair to any
// result without being one of the players.
export async function recordSet(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerAId = String(formData.get("playerAId") ?? "");
  const playerBId = String(formData.get("playerBId") ?? "");
  const result = String(formData.get("result") ?? "") as Result;
  if (!divisionId || !playerAId || !playerBId || !["2-0", "1-1", "0-2"].includes(result)) return;
  await recordResult({ divisionId, playerAId, playerBId, result, actor: actorFromAdminUser(user) });
  revalidatePath(`/divisions/${divisionId}`);
}

// Void a single game (record 0-0): finished, no points, not a W/L/D.
export async function voidGameAction(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const p1Id = String(formData.get("p1") ?? "");
  const p2Id = String(formData.get("p2") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const r = await voidGame({ divisionId, p1Id, p2Id, reason, actor: actorFromAdminUser(user) });
  if (!r.ok) redirect(`/divisions/${divisionId}?err=${encodeURIComponent(r.reason)}`);
  revalidatePath(`/divisions/${divisionId}`);
  redirect(`/divisions/${divisionId}?ok=game-voided`);
}

// DQ a player by voiding their whole season in this division (cancels all their
// games + drops them). Mirrors the bot's /admin void-player.
export async function voidPlayerAction(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const r = await voidPlayerInDivision({ divisionId, playerId, reason, actor: actorFromAdminUser(user) });
  if (!r.ok) redirect(`/divisions/${divisionId}?err=${encodeURIComponent(r.reason)}`);
  revalidatePath(`/divisions/${divisionId}`);
  redirect(`/divisions/${divisionId}?ok=player-voided`);
}

// Record (or overwrite) a shootout result for two members in this
// division. Mirrors the bot's /admin record-shootout flow but server-
// side via a form action. Canonical player ordering matches the
// Pairing convention so the unique constraint catches duplicates.
export async function recordShootout(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const p1Id = String(formData.get("p1") ?? "");
  const p2Id = String(formData.get("p2") ?? "");
  const winnerId = String(formData.get("winnerId") ?? "");
  await recordShowdown({ divisionId, p1Id, p2Id, winnerId, actor: actorFromAdminUser(user) });
  revalidatePath(`/divisions/${divisionId}`);
}

// Resolve a tie of any size: the admin types a placement number per tied
// player (1 = winner; equal numbers = those players stay tied with each other),
// and we write the showdowns that encode it. Handles 3-way+ ties the single
// p1-vs-p2 showdown can't, while letting the "losers" remain tied.
export async function resolveTieAction(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const placements: Array<{ playerId: string; place: number }> = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("place_")) continue;
    const playerId = key.slice("place_".length);
    const place = parseInt(String(value), 10);
    if (playerId && Number.isFinite(place)) placements.push({ playerId, place });
  }
  const r = await resolveTieWithShowdowns({ divisionId, placements, actor: actorFromAdminUser(user) });
  if (!r.ok) redirect(`/divisions/${divisionId}?err=${encodeURIComponent(r.reason)}`);
  revalidatePath(`/divisions/${divisionId}`);
  redirect(`/divisions/${divisionId}?ok=tie-resolved`);
}

// Remove a showdown — sort falls back to the next tiebreaker (wins,
// draws, alphabetical). Useful when an admin records a wrong winner.
export async function deleteShootout(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const p1Id = String(formData.get("p1") ?? "");
  const p2Id = String(formData.get("p2") ?? "");
  if (!divisionId || !p1Id || !p2Id) return;
  const [canonA, canonB] = p1Id < p2Id ? [p1Id, p2Id] : [p2Id, p1Id];
  const m = await prisma.match.findUnique({
    where: { divisionId_playerAId_playerBId_format: { divisionId, playerAId: canonA, playerBId: canonB, format: "SHOOTOUT_BO1" } },
    select: { id: true },
  });
  if (m) await undoResult({ matchId: m.id, actor: actorFromAdminUser(user) });
  revalidatePath(`/divisions/${divisionId}`);
}

// Record (or FIX) a forfeit / DQ between two members of this division. Upserts
// the LEAGUE_BO2 match to 2-0 for the winner with the forfeit flag — so it both
// records a brand-new DQ AND overwrites a wrong existing one in place (no need
// to delete first). Works whether the pair has played or not. The reason is
// admin-only (forfeitReason + audit), never shown publicly.
export async function recordForfeitInDivision(formData: FormData) {
  const { user } = await requireAdmin();
  const divisionId = String(formData.get("divisionId") ?? "");
  const winnerId = String(formData.get("winnerId") ?? "");
  const loserId = String(formData.get("loserId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  await forfeitResult({ divisionId, winnerId, loserId, reason, actor: actorFromAdminUser(user) });
  revalidatePath(`/divisions/${divisionId}`);
}
