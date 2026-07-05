"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser } from "@/lib/audit";
import { resolveDiscordIdToDisplayName } from "@/lib/add-player";
import { isDiscordIdBanned, isPlayerIdBanned } from "@/lib/bans";
import { enqueueMmrSnapshot } from "@/lib/queue";
import { buildSeasonFromRound } from "@/lib/build-season";

// Bulk-update ratings for signed-up players. Creates Player rows for new
// signups so the rating sticks before we build the season.
// Enqueue a fresh balatromp.com snapshot job for every active signup in
// this round. Idempotent — each job inserts a new snapshot row, so the
// build page just reads the latest by capturedAt.
export async function refreshSignupMmrSnapshots(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return;
  // Snapshots aren't tied to a season until build-season runs, so seasonId
  // is the round's resultingSeasonId (may be null pre-build, fine).
  const seasonId = round.resultingSeasonId;
  await Promise.all(
    round.signups.map((s) =>
      enqueueMmrSnapshot({ discordId: s.discordId, seasonId }).catch((err) =>
        console.warn(`[refresh-mmr] enqueue failed for ${s.discordId}:`, err),
      ),
    ),
  );
  revalidatePath(`/admin/signups/${roundId}/build`);
}

// Pre-fill league ranks from each signup's latest BMP Ranked MMR
// snapshot. Rating is now a rank (1 = best), so we sort signups by
// BMP MMR DESC and write the resulting position as the rank.
//
// ONLY fills players who don't already have a rank — existing returners'
// league ratings are never overwritten by this path. New players get
// ranks appended after the highest existing rank, sorted among themselves
// by BMP MMR DESC.
export async function autoFillRatingsFromMmr(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return;
  const discordIds = round.signups.map((s) => s.discordId);
  const snapshots = await prisma.playerMmrSnapshot.findMany({
    where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
    orderBy: { capturedAt: "desc" },
    distinct: ["discordId"],
  });
  const mmrByDiscordId = new Map(snapshots.map((s) => [s.discordId, s.rankedMmr!]));
  const existingPlayers = await prisma.player.findMany({
    where: { discordId: { in: discordIds } },
  });
  const playerByDiscordId = new Map(existingPlayers.map((p) => [p.discordId, p]));

  // Returners keep their existing rank, unranked players
  // get ranks appended at the bottom, sorted among themselves by BMP MMR.
  const maxExistingRank = existingPlayers.reduce((max, p) => (p.rating != null && p.rating > max ? p.rating : max), 0);
  const unranked = round.signups.filter((s) => {
    const p = playerByDiscordId.get(s.discordId);
    return !p || p.rating == null;
  });
  // Sort unranked by BMP MMR DESC for relative ordering.
  unranked.sort((a, b) => {
    const am = mmrByDiscordId.get(a.discordId) ?? -1;
    const bm = mmrByDiscordId.get(b.discordId) ?? -1;
    if (am !== bm) return bm - am;
    return a.signedUpAt.getTime() - b.signedUpAt.getTime();
  });
  let filled = 0;
  for (let i = 0; i < unranked.length; i++) {
    const signup = unranked[i]!;
    const rank = maxExistingRank + i + 1;
    await prisma.player.upsert({
      where: { discordId: signup.discordId },
      create: { discordId: signup.discordId, displayName: signup.displayName, rating: rank, ratingNote: "Auto-ranked from BMP MMR (appended after returners)" },
      update: { rating: rank, displayName: signup.displayName, ratingNote: "Auto-ranked from BMP MMR (appended after returners)" },
    });
    filled++;
  }
  console.log(`[auto-fill-ratings] ranked ${filled} unrated signups`);
  revalidatePath(`/admin/signups/${roundId}/build`);
}

export async function saveRatings(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return;

  // The drag-and-drop UI submits an `order` field — a JSON array of
  // discord IDs in admin-chosen rank order. If present, derive each
  // player's rating from their position so the visual order is the
  // source of truth (no two players can tie). Highest position = #1
  // = highest rating. We use a wide spread (10 per slot) so future
  // manual nudges between two consecutive players don't have to
  // reshuffle the whole list.
  const orderRaw = formData.get("order");
  if (typeof orderRaw === "string" && orderRaw.length > 0) {
    let orderIds: string[] = [];
    try {
      const parsed = JSON.parse(orderRaw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        orderIds = parsed;
      }
    } catch {
      // Bad JSON — fall back to legacy per-field path below.
    }
    if (orderIds.length > 0) {
      const signupByDiscordId = new Map(round.signups.map((s) => [s.discordId, s]));
      // Rating = rank (1 = best). Position 0 in the drag list → rank 1.
      for (let i = 0; i < orderIds.length; i++) {
        const discordId = orderIds[i]!;
        const signup = signupByDiscordId.get(discordId);
        if (!signup) continue;
        const rating = i + 1;
        await prisma.player.upsert({
          where: { discordId: signup.discordId },
          create: { discordId: signup.discordId, displayName: signup.displayName, rating, ratingNote: "Rank set from build-page drag order" },
          update: { rating, displayName: signup.displayName, ratingNote: "Rank set from build-page drag order" },
        });
      }
      revalidatePath(`/admin/signups/${roundId}/build`);
      return;
    }
  }

  // Legacy path: per-row rating: input fields (kept for backward compat
  // and the "Auto-fill from BMP MMR" flow which sets individual values).
  for (const signup of round.signups) {
    const raw = formData.get(`rating:${signup.discordId}`);
    if (raw === null) continue;
    const str = String(raw).trim();
    const rating = str === "" ? null : parseInt(str, 10);
    if (str !== "" && Number.isNaN(rating)) continue;
    await prisma.player.upsert({
      where: { discordId: signup.discordId },
      create: { discordId: signup.discordId, displayName: signup.displayName, rating },
      update: { rating, displayName: signup.displayName },
    });
  }
  revalidatePath(`/admin/signups/${roundId}/build`);
}

// Late add: insert a Signup into a round by Discord ID. Display name is
// fetched from the guild but admin can override via the form. Works on
// OPEN, CLOSED, or unbuilt rounds — anything not yet BUILT.
export async function addSignupByDiscordId(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  const discordIdRaw = String(formData.get("discordId") ?? "");
  const displayNameOverride = String(formData.get("displayName") ?? "").trim();
  if (!roundId || !discordIdRaw) {
    redirect(`/admin/signups/${roundId}/build?err=missing-fields`);
  }
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) redirect(`/admin/signups/${roundId}/build?err=no-guild-id`);

  const resolved = await resolveDiscordIdToDisplayName(guildId, discordIdRaw);
  if ("error" in resolved) {
    redirect(`/admin/signups/${roundId}/build?err=${encodeURIComponent(resolved.error)}`);
  }
  if (await isDiscordIdBanned(resolved.discordId)) {
    redirect(`/admin/signups/${roundId}/build?err=${encodeURIComponent("That player is banned — unban them at /admin/bans first.")}`);
  }

  await prisma.signup.upsert({
    where: { roundId_discordId: { roundId, discordId: resolved.discordId } },
    create: {
      roundId,
      discordId: resolved.discordId,
      displayName: displayNameOverride || resolved.displayName,
      withdrawn: false,
    },
    update: {
      displayName: displayNameOverride || resolved.displayName,
      withdrawn: false,
    },
  });

  revalidatePath(`/admin/signups/${roundId}/build`);
}

// Add an EXISTING player to the signup round by player id (from the search
// picker) — looks up their Discord id + name, no manual ID typing.
export async function addSignupByPlayerId(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  const playerId = String(formData.get("playerId") ?? "");
  if (!roundId || !playerId) {
    redirect(`/admin/signups/${roundId}/build?err=missing-fields`);
  }
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { discordId: true, displayName: true },
  });
  if (!player) {
    redirect(`/admin/signups/${roundId}/build?err=${encodeURIComponent("Player not found")}`);
  }
  if (await isPlayerIdBanned(playerId)) {
    redirect(`/admin/signups/${roundId}/build?err=${encodeURIComponent("That player is banned — unban them at /admin/bans first.")}`);
  }
  await prisma.signup.upsert({
    where: { roundId_discordId: { roundId, discordId: player!.discordId } },
    create: { roundId, discordId: player!.discordId, displayName: player!.displayName, withdrawn: false },
    update: { displayName: player!.displayName, withdrawn: false },
  });
  revalidatePath(`/admin/signups/${roundId}/build`);
}

// Commit: place players into divisions and mark round BUILT.
//
// Two modes (auto-detected):
//   1. Round was opened standalone (resultingSeasonId not set yet) → CREATE
//      a new season + tiers + divisions using the form config, then populate.
//   2. Round was opened from a season card (resultingSeasonId pre-set) →
//      POPULATE the existing season's divisions. Form's tier config is
//      ignored — we use the season's existing shape.
export async function buildSeason(formData: FormData) {
  const { user } = await requireAdmin();

  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;

  const subtitleRaw = String(formData.get("subtitle") ?? "").trim();
  const matchConfigPresetIdRaw = String(formData.get("matchConfigPresetId") ?? "");

  const result = await buildSeasonFromRound({
    roundId,
    subtitle: subtitleRaw.length > 0 ? subtitleRaw : null,
    config: String(formData.get("config") ?? ""),
    targetGroupSize: parseInt(String(formData.get("targetGroupSize")), 10) || undefined,
    minGroupSize: parseInt(String(formData.get("minGroupSize")), 10) || undefined,
    matchConfigPresetId: matchConfigPresetIdRaw === "" ? null : matchConfigPresetIdRaw,
    actor: actorFromAdminUser(user),
  });
  if (!result) return;

  revalidatePath("/admin/signups");
  revalidatePath("/admin/seasons");
  // Land on the new season's detail page (in draft mode) instead of
  // the seasons index. The detail page is where admin reviews and
  // tweaks division placements before activating — that's the natural
  // next step in the workflow.
  redirect(`/seasons/${result.seasonId}?just-built=1`);
}
