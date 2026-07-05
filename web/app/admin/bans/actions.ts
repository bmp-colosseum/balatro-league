"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { recordAudit, actorFromAdminUser } from "@/lib/audit";
import { nextSeasonNumber } from "@/lib/bans";

// Ban a player: blocks signing up, being added to a round, opting into reminders,
// being placed into a division, and starting/queuing any match. PERMANENT (no
// duration) or a season-count TEMP ban (auto-lifts after N seasons). Reason is
// admin-only (stored + audited). Does NOT remove them from a live season — use
// the division DQ/void tools for that.
export async function banPlayerAction(formData: FormData) {
  const { user } = await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const durationRaw = String(formData.get("duration") ?? "permanent").trim(); // "permanent" | "1".."N"
  if (!playerId) redirect(`/admin/bans?err=${encodeURIComponent("Pick a player to ban.")}`);
  if (!reason) redirect(`/admin/bans?err=${encodeURIComponent("A reason is required.")}`);

  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { displayName: true } });
  if (!player) redirect(`/admin/bans?err=${encodeURIComponent("Player not found.")}`);

  // Permanent (null) or a season-count ban that lifts at nextSeasonNumber + N.
  let banLiftsAtSeasonNumber: number | null = null;
  let durationLabel = "permanently";
  if (durationRaw !== "permanent") {
    const seasons = Math.max(1, Math.min(20, parseInt(durationRaw, 10) || 1));
    banLiftsAtSeasonNumber = (await nextSeasonNumber()) + seasons;
    durationLabel = `for ${seasons} season${seasons === 1 ? "" : "s"} (through Season ${banLiftsAtSeasonNumber - 1})`;
  }

  const actor = actorFromAdminUser(user);
  await prisma.player.update({
    where: { id: playerId },
    data: { bannedAt: new Date(), bannedReason: reason, bannedBy: actor.discordId, banLiftsAtSeasonNumber },
  });
  await recordAudit({
    actor,
    action: "player.ban",
    targetType: "Player",
    targetId: playerId,
    summary: `Banned ${player!.displayName} ${durationLabel}`,
    metadata: { reason, banLiftsAtSeasonNumber },
  });
  revalidatePath("/admin/bans");
  redirect(`/admin/bans?ok=${encodeURIComponent(`Banned ${player!.displayName} ${durationLabel}.`)}`);
}

export async function unbanPlayerAction(formData: FormData) {
  const { user } = await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "").trim();
  if (!playerId) return;
  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { displayName: true } });
  await prisma.player.update({
    where: { id: playerId },
    data: { bannedAt: null, bannedReason: null, bannedBy: null, banLiftsAtSeasonNumber: null },
  });
  const actor = actorFromAdminUser(user);
  await recordAudit({
    actor,
    action: "player.unban",
    targetType: "Player",
    targetId: playerId,
    summary: `Unbanned ${player?.displayName ?? playerId}`,
  });
  revalidatePath("/admin/bans");
  redirect(`/admin/bans?ok=${encodeURIComponent(`Unbanned ${player?.displayName ?? "player"}.`)}`);
}

// Log a strike (repeat-offender record). Mirrors the Discord /admin strike, so
// the count is shared. Strikes are surfaced for the admin to act on — they do NOT
// auto-ban.
export async function addStrikeAction(formData: FormData) {
  const { user } = await requireAdmin();
  const playerId = String(formData.get("playerId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!playerId) redirect(`/admin/bans?err=${encodeURIComponent("Pick a player to strike.")}`);
  if (!reason) redirect(`/admin/bans?err=${encodeURIComponent("A strike reason is required.")}`);
  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { displayName: true } });
  if (!player) redirect(`/admin/bans?err=${encodeURIComponent("Player not found.")}`);

  const actor = actorFromAdminUser(user);
  await prisma.strike.create({
    data: { playerId, reason, issuedById: actor.discordId, issuedByName: actor.displayName ?? "admin" },
  });
  const count = await prisma.strike.count({ where: { playerId } });
  await recordAudit({
    actor,
    action: "strike.add",
    targetType: "Player",
    targetId: playerId,
    summary: `Struck ${player!.displayName} (#${count})`,
    metadata: { reason },
  });
  revalidatePath("/admin/bans");
  redirect(`/admin/bans?ok=${encodeURIComponent(`Logged strike #${count} for ${player!.displayName}.`)}`);
}

export async function removeStrikeAction(formData: FormData) {
  const { user } = await requireAdmin();
  const strikeId = String(formData.get("strikeId") ?? "").trim();
  if (!strikeId) return;
  const strike = await prisma.strike.findUnique({ where: { id: strikeId }, select: { playerId: true } });
  await prisma.strike.delete({ where: { id: strikeId } }).catch(() => {});
  const actor = actorFromAdminUser(user);
  await recordAudit({
    actor,
    action: "strike.remove",
    targetType: "Player",
    targetId: strike?.playerId ?? strikeId,
    summary: `Removed a strike`,
  });
  revalidatePath("/admin/bans");
  redirect(`/admin/bans?ok=${encodeURIComponent("Removed a strike.")}`);
}
