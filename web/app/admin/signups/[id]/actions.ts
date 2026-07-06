"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { enqueueMmrSnapshot } from "@/lib/queue";
import { resolveDiscordIdToDisplayName } from "@/lib/add-player";
import { isDiscordIdBanned, isPlayerIdBanned, nextSeasonNumber } from "@/lib/bans";
import { refreshSignupPost } from "@/lib/signup-discord";
import { recordAudit, actorFromAdminUser } from "@/lib/audit";

// Add a sign-up to a round straight from the round page — by Discord ID, or an
// existing player picked by name. Either way it creates a Signup row (so they're
// in the count + roster), and the draft auto-absorbs them next time it's opened.
export async function addSignupToRound(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;
  const playerId = String(formData.get("playerId") ?? "").trim();
  const discordIdRaw = String(formData.get("discordId") ?? "").trim();
  const displayNameOverride = String(formData.get("displayName") ?? "").trim();

  const bannedErr = `/admin/signups/${roundId}?err=${encodeURIComponent("That player is banned — unban them at /admin/bans first.")}`;
  const upsert = (discordId: string, displayName: string) =>
    prisma.signup.upsert({
      where: { roundId_discordId: { roundId, discordId } },
      create: { roundId, discordId, displayName, withdrawn: false },
      update: { displayName, withdrawn: false },
    });

  if (playerId) {
    const player = await prisma.player.findUnique({ where: { id: playerId }, select: { discordId: true, displayName: true } });
    if (!player) redirect(`/admin/signups/${roundId}?err=${encodeURIComponent("Player not found")}`);
    if (await isPlayerIdBanned(playerId)) redirect(bannedErr);
    await upsert(player!.discordId, player!.displayName);
    revalidatePath(`/admin/signups/${roundId}`);
    return;
  }

  if (discordIdRaw) {
    const guildId = process.env.DISCORD_GUILD_ID;
    let discordId = discordIdRaw;
    let displayName = displayNameOverride;
    if (guildId) {
      const resolved = await resolveDiscordIdToDisplayName(guildId, discordIdRaw);
      if ("error" in resolved) redirect(`/admin/signups/${roundId}?err=${encodeURIComponent(resolved.error)}`);
      discordId = resolved.discordId;
      if (!displayName) displayName = resolved.displayName;
    }
    if (!displayName) displayName = discordId;
    if (await isDiscordIdBanned(discordId)) redirect(bannedErr);
    await upsert(discordId, displayName);
    revalidatePath(`/admin/signups/${roundId}`);
    return;
  }

  redirect(`/admin/signups/${roundId}?err=${encodeURIComponent("Enter a Discord ID or pick a player")}`);
}

// Enqueue a fresh balatromp.com MMR fetch for every non-withdrawn signup in a
// round, so the pre-season MMR distribution can be populated/refreshed even
// while signups are still open. Ad-hoc capture (seasonId = the resulting season
// if one exists yet, else null — the round isn't a Season until build).
export async function refreshSignupMmrs(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) redirect("/admin/seasons");
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false }, select: { discordId: true } } },
  });
  if (!round) redirect("/admin/seasons");
  for (const s of round!.signups) {
    await enqueueMmrSnapshot({ discordId: s.discordId, seasonId: round!.resultingSeasonId ?? null }).catch(() => {});
  }
  redirect(`/admin/signups/${roundId}?refreshing=${round!.signups.length}`);
}

// Remove a player from a signup round (admin). Soft-delete via withdrawn:true
// (same as a self-withdraw), so they drop off the roster + count and won't be
// built into the season, but the record is kept. Keeps the Discord post's count
// live. Use this to drop someone who signed up but shouldn't play.
export async function withdrawSignupAction(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "").trim();
  const discordId = String(formData.get("discordId") ?? "").trim();
  if (!roundId || !discordId) return;
  await prisma.signup.updateMany({ where: { roundId, discordId }, data: { withdrawn: true } });
  await refreshSignupPost(roundId).catch(() => {});
  revalidatePath(`/admin/signups/${roundId}`);
  redirect(`/admin/signups/${roundId}?ok=${encodeURIComponent("Removed from signups.")}`);
}

// Remove from the round AND ban the player for one season, so they can't sign up
// again. Creates a Player row if they don't have one yet (a ban keyed by a
// missing Player wouldn't block anything). Season ban auto-lifts a season later.
export async function removeAndBanSignupAction(formData: FormData) {
  const { user } = await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "").trim();
  const discordId = String(formData.get("discordId") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim() || discordId;
  if (!roundId || !discordId) return;
  const actor = actorFromAdminUser(user);
  const reason = "Removed from signups (season ban)";
  const banLiftsAtSeasonNumber = (await nextSeasonNumber()) + 1;

  const player = await prisma.player.upsert({
    where: { discordId },
    create: { discordId, displayName, bannedAt: new Date(), bannedReason: reason, bannedBy: actor.discordId, banLiftsAtSeasonNumber },
    update: { bannedAt: new Date(), bannedReason: reason, bannedBy: actor.discordId, banLiftsAtSeasonNumber },
  });
  await prisma.signup.updateMany({ where: { roundId, discordId }, data: { withdrawn: true } });
  await refreshSignupPost(roundId).catch(() => {});
  await recordAudit({
    actor,
    action: "player.ban",
    targetType: "Player",
    targetId: player.id,
    summary: `Removed ${displayName} from signups + banned for 1 season (through Season ${banLiftsAtSeasonNumber - 1})`,
    metadata: { reason, banLiftsAtSeasonNumber, roundId },
  });
  revalidatePath(`/admin/signups/${roundId}`);
  redirect(`/admin/signups/${roundId}?ok=${encodeURIComponent(`Removed + banned ${displayName} for 1 season.`)}`);
}
