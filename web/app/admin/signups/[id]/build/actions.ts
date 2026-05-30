"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

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

// Distribute ranked players top-down into tiers, snake-drafted within each tier.
// Snake-draft balances skill across divisions in the same tier.
function planByRating(
  ranked: Array<{ id: string; discordId: string; displayName: string; rating: number | null }>,
  tiers: TierConfig[],
  targetGroupSize: number,
): Array<{ tier: TierConfig; position: number; divisions: string[][] /* signup discordIds per division */ }> {
  // Sort by rating DESC (null = lowest, displayName as tiebreaker)
  const sorted = [...ranked].sort((a, b) => {
    const ra = a.rating ?? -1;
    const rb = b.rating ?? -1;
    if (ra !== rb) return rb - ra;
    return a.displayName.localeCompare(b.displayName);
  });

  const plan: ReturnType<typeof planByRating> = [];
  let cursor = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    const isLast = i === tiers.length - 1;
    const capacity = isLast
      ? sorted.length - cursor // bottom tier takes everyone left
      : Math.min(tier.divisionCount * targetGroupSize, sorted.length - cursor);
    const tierPlayers = sorted.slice(cursor, cursor + capacity).map((p) => p.discordId);
    cursor += capacity;

    // Snake-draft: P1→D1, P2→D2, P3→D2, P4→D1, P5→D1, ...
    const numDivs = Math.max(1, tier.divisionCount);
    const divisions: string[][] = Array.from({ length: numDivs }, () => []);
    tierPlayers.forEach((discordId, idx) => {
      const round = Math.floor(idx / numDivs);
      const slot = idx % numDivs;
      const divIdx = round % 2 === 0 ? slot : numDivs - 1 - slot;
      divisions[divIdx]!.push(discordId);
    });

    plan.push({ tier, position: i + 1, divisions });
    if (cursor >= sorted.length) {
      // Fill remaining tiers as empty so admin still sees the shape
      for (let j = i + 1; j < tiers.length; j++) {
        plan.push({
          tier: tiers[j]!,
          position: j + 1,
          divisions: Array.from({ length: Math.max(1, tiers[j]!.divisionCount) }, () => []),
        });
      }
      break;
    }
  }
  return plan;
}

// Bulk-update ratings for signed-up players. Creates Player rows for new
// signups so the rating sticks before we build the season.
export async function saveRatings(formData: FormData) {
  await requireAdmin();
  const roundId = String(formData.get("roundId") ?? "");
  if (!roundId) return;

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return;

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

// Commit: create season + tiers + divisions, place players, mark round BUILT.
export async function buildSeason(formData: FormData) {
  await requireAdmin();

  const roundId = String(formData.get("roundId") ?? "");
  const seasonName = String(formData.get("name") ?? "").trim();
  const tiersJson = String(formData.get("config") ?? "");
  const tiers = parseTierConfig(tiersJson);
  if (!roundId || !seasonName || tiers.length === 0) return;

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

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return;

  // Upsert players + collect their current ratings
  const players = await Promise.all(
    round.signups.map((s) =>
      prisma.player.upsert({
        where: { discordId: s.discordId },
        create: { discordId: s.discordId, displayName: s.displayName },
        update: { displayName: s.displayName },
      }),
    ),
  );

  const plan = planByRating(
    players.map((p) => ({ id: p.id, discordId: p.discordId, displayName: p.displayName, rating: p.rating })),
    tiers,
    targetGroupSize,
  );

  // Build season + tiers + divisions + memberships in a transaction
  const season = await prisma.season.create({
    data: {
      name: seasonName,
      deadline,
      isActive: false,
      targetGroupSize,
      minGroupSize,
      visibility,
      matchConfigPresetId,
    },
  });

  const playerByDiscordId = new Map(players.map((p) => [p.discordId, p]));

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
        await prisma.divisionMember.create({
          data: { divisionId: division.id, playerId: player.id },
        });
      }
    }
  }

  await prisma.signupRound.update({
    where: { id: roundId },
    data: { status: "BUILT", resultingSeasonId: season.id },
  });

  revalidatePath("/admin/signups");
  revalidatePath("/admin/seasons");
  redirect(`/admin/seasons`);
}
