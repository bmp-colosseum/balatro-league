"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { resolveDiscordIdToDisplayName } from "@/lib/add-player";
import { placePlayerInDivision } from "@/lib/division-membership";
import { enqueueMmrSnapshot } from "@/lib/queue";
import { formatSeasonLabel, nextSeasonNumber } from "@/lib/format-season";

interface TierConfig {
  name: string;
  divisionCount: number;
}

function parseTierConfig(json: string): TierConfig[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((e) => ({
        name: String(e?.name ?? "").trim(),
        divisionCount: Math.max(1, Math.min(50, Math.floor(Number(e?.divisionCount)))) || 1,
      }))
      .filter((t) => t.name.length > 0);
  } catch {
    return [];
  }
}

// Distribute ranked players top-down into tiers, filling each division
// in rank order. Rare 1 takes the top 5 Rare ranks, Rare 2 the next 5,
// ..., Rare 6 the bottom 5. (Previously snake-drafted to balance skill
// across same-tier divisions, but that made entering rank diverge wildly
// from ending rank since the per-division end-season recompute reranks
// every player to their division's rank slot.)
//
// Filling strategy: every division ends up with either `base` or `base+1`
// players, where base = floor(N / totalDivs). Extras (the `N mod totalDivs`
// players who push some divisions to base+1) go to UPPER tiers first —
// Legendary/Rare fill before Common takes leftovers. No special case for
// the top tier — it's just another tier in the math.
function planByRating(
  ranked: Array<{ id: string; discordId: string; displayName: string; rating: number | null }>,
  tiers: TierConfig[],
  targetGroupSize: number,
): Array<{ tier: TierConfig; position: number; divisions: string[][] /* signup discordIds per division */ }> {
  void targetGroupSize; // kept on signature for caller compat; new alg derives sizes dynamically
  // Sort by rating ASC (rating = rank, 1 = best player). null
  // (unrated) sorts AFTER ranked players via Infinity sentinel.
  const sorted = [...ranked].sort((a, b) => {
    const ra = a.rating ?? Number.POSITIVE_INFINITY;
    const rb = b.rating ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.displayName.localeCompare(b.displayName);
  });

  if (sorted.length === 0 || tiers.length === 0) {
    return tiers.map((tier, i) => ({
      tier,
      position: i + 1,
      divisions: Array.from({ length: Math.max(1, tier.divisionCount) }, () => []),
    }));
  }

  const totalDivs = tiers.reduce((sum, t) => sum + Math.max(1, t.divisionCount), 0);
  const base = totalDivs === 0 ? 0 : Math.floor(sorted.length / totalDivs);
  let extras = totalDivs === 0 ? 0 : sorted.length - base * totalDivs;
  const divisionSizes: number[][] = tiers.map((t) => {
    const numDivs = Math.max(1, t.divisionCount);
    return Array.from({ length: numDivs }, () => {
      const extra = extras > 0 ? 1 : 0;
      if (extras > 0) extras--;
      return base + extra;
    });
  });

  const plan: ReturnType<typeof planByRating> = [];
  let cursor = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    const numDivs = Math.max(1, tier.divisionCount);
    const sizes = divisionSizes[i]!;

    // Sequential fill: division 0 takes the next `sizes[0]` players in
    // rank order, division 1 takes the next `sizes[1]`, etc. So Rare 1
    // gets the strongest Rare players, Rare 6 gets the weakest.
    const divisions: string[][] = [];
    for (let d = 0; d < numDivs; d++) {
      const size = sizes[d]!;
      const slice = sorted.slice(cursor, cursor + size).map((p) => p.discordId);
      cursor += size;
      divisions.push(slice);
    }

    plan.push({ tier, position: i + 1, divisions });
  }
  return plan;
}

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

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return;

  const players = await Promise.all(
    round.signups.map((s) =>
      prisma.player.upsert({
        where: { discordId: s.discordId },
        create: { discordId: s.discordId, displayName: s.displayName },
        update: { displayName: s.displayName },
      }),
    ),
  );
  const playerByDiscordId = new Map(players.map((p) => [p.discordId, p]));

  let targetSeasonId: string;

  if (round.resultingSeasonId) {
    // Populate-existing mode
    const existing = await prisma.season.findUnique({
      where: { id: round.resultingSeasonId },
      include: {
        tiers: { orderBy: { position: "asc" } },
        divisions: { orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }], include: { tier: true } },
      },
    });
    if (!existing) return;

    // If the season has no tiers yet (admin deferred shape until after
    // signups closed), create them now from the build form's tier config.
    if (existing.tiers.length === 0) {
      const formTiers = parseTierConfig(String(formData.get("config") ?? ""));
      if (formTiers.length === 0) {
        // No shape supplied — caller should re-submit the build form with one.
        return;
      }
      for (let i = 0; i < formTiers.length; i++) {
        const c = formTiers[i]!;
        const tier = await prisma.tier.create({
          data: { seasonId: existing.id, position: i + 1, name: c.name },
        });
        for (let g = 1; g <= c.divisionCount; g++) {
          const divisionName = c.divisionCount === 1 ? c.name : `${c.name} ${g}`;
          await prisma.division.create({
            data: { seasonId: existing.id, tierId: tier.id, groupNumber: g, name: divisionName },
          });
        }
      }
      // Re-fetch so the placement loop below sees the freshly-created tiers
      const refetched = await prisma.season.findUnique({
        where: { id: existing.id },
        include: {
          tiers: { orderBy: { position: "asc" } },
          divisions: { orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }], include: { tier: true } },
        },
      });
      if (refetched) {
        existing.tiers = refetched.tiers;
        existing.divisions = refetched.divisions;
      }
    }

    const existingTierConfigs: TierConfig[] = existing.tiers.map((t) => ({
      name: t.name,
      divisionCount: existing.divisions.filter((d) => d.tierId === t.id).length,
    }));

    const plan = planByRating(
      players.map((p) => ({ id: p.id, discordId: p.discordId, displayName: p.displayName, rating: p.rating })),
      existingTierConfigs,
      existing.targetGroupSize,
    );

    for (const planTier of plan) {
      const dbTier = existing.tiers.find((t) => t.position === planTier.position);
      if (!dbTier) continue;
      const dbDivisions = existing.divisions
        .filter((d) => d.tierId === dbTier.id)
        .sort((a, b) => a.groupNumber - b.groupNumber);
      for (let gi = 0; gi < planTier.divisions.length && gi < dbDivisions.length; gi++) {
        const division = dbDivisions[gi]!;
        for (const discordId of planTier.divisions[gi]!) {
          const player = playerByDiscordId.get(discordId);
          if (!player) continue;
          await placePlayerInDivision(division.id, player.id);
        }
      }
    }
    targetSeasonId = existing.id;
  } else {
    // Create-new mode (original behavior)
    const subtitleRaw = String(formData.get("subtitle") ?? "").trim();
    const subtitle = subtitleRaw.length > 0 ? subtitleRaw : null;
    const tiersJson = String(formData.get("config") ?? "");
    const tiers = parseTierConfig(tiersJson);
    if (tiers.length === 0) return;

    const targetGroupSize = Math.max(2, parseInt(String(formData.get("targetGroupSize")), 10) || 5);
    const minGroupSize = Math.max(2, parseInt(String(formData.get("minGroupSize")), 10) || 3);
    const visibility = formData.get("visibility") === "INTERNAL" ? "INTERNAL" : "PUBLIC";
    const matchConfigPresetIdRaw = String(formData.get("matchConfigPresetId") ?? "");
    const matchConfigPresetId = matchConfigPresetIdRaw === "" ? null : matchConfigPresetIdRaw;

    let deadline: Date | null = null;
    const deadlineStr = String(formData.get("deadline") ?? "");
    if (deadlineStr) {
      const d = new Date(deadlineStr + "Z");
      if (!Number.isNaN(d.getTime())) deadline = d;
    }

    const plan = planByRating(
      players.map((p) => ({ id: p.id, discordId: p.discordId, displayName: p.displayName, rating: p.rating })),
      tiers,
      targetGroupSize,
    );

    const number = await nextSeasonNumber(prisma);
    const season = await prisma.season.create({
      data: {
        number,
        subtitle,
        deadline,
        isActive: false,
        targetGroupSize,
        minGroupSize,
        visibility,
        matchConfigPresetId,
      },
    });

    for (const planTier of plan) {
      const tier = await prisma.tier.create({
        data: { seasonId: season.id, position: planTier.position, name: planTier.tier.name },
      });
      for (let gi = 0; gi < planTier.divisions.length; gi++) {
        const memberDiscordIds = planTier.divisions[gi]!;
        const divisionName =
          planTier.tier.divisionCount === 1 && gi === 0
            ? planTier.tier.name
            : `${planTier.tier.name} ${gi + 1}`;
        const division = await prisma.division.create({
          data: {
            seasonId: season.id,
            tierId: tier.id,
            groupNumber: gi + 1,
            name: divisionName,
          },
        });
        for (const discordId of memberDiscordIds) {
          const player = playerByDiscordId.get(discordId);
          if (!player) continue;
          await placePlayerInDivision(division.id, player.id);
        }
      }
    }
    targetSeasonId = season.id;
  }

  await prisma.signupRound.update({
    where: { id: roundId },
    data: { status: "BUILT", resultingSeasonId: targetSeasonId },
  });
  // Snapshot the final shape for the audit log so we can see what was
  // built without diffing against the now-mutable season state.
  const finalShape = await prisma.season.findUnique({
    where: { id: targetSeasonId },
    select: {
      number: true,
      subtitle: true,
      divisions: {
        select: {
          name: true,
          _count: { select: { members: { where: { status: "ACTIVE" } } } },
        },
      },
    },
  });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.build",
    targetType: "Season",
    targetId: targetSeasonId,
    summary: `Built season "${finalShape ? formatSeasonLabel(finalShape) : targetSeasonId}" (${finalShape?.divisions.length ?? 0} divisions, ${players.length} signups placed)`,
    metadata: {
      roundId,
      signupCount: players.length,
      divisions: finalShape?.divisions.map((d) => ({ name: d.name, memberCount: d._count.members })) ?? [],
    },
  });

  revalidatePath("/admin/signups");
  revalidatePath("/admin/seasons");
  // Land on the new season's detail page (in draft mode) instead of
  // the seasons index. The detail page is where admin reviews and
  // tweaks division placements before activating — that's the natural
  // next step in the workflow.
  redirect(`/admin/seasons/${targetSeasonId}?just-built=1`);
}
