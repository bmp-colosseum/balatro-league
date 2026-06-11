// Real season build — extracted from the build-page server action so it
// can be driven from BOTH the admin UI (FormData) and ADMIN_TOKEN ops
// endpoints (JSON) without duplicating the placement logic.
//
// buildSeasonFromRound() takes a signup round + the tier shape and either
//   1. CREATEs a new season + tiers + divisions and places players, or
//   2. POPULATEs an existing season the round was opened from.
// It leaves the season isActive:false (same as the UI) — activation is a
// separate step. Callers handle revalidate/redirect/auth themselves.

import { prisma } from "@/lib/prisma";
import { placePlayerInDivision } from "@/lib/division-membership";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { formatSeasonLabel, nextSeasonNumber } from "@/lib/format-season";

export interface TierConfig {
  name: string;
  divisionCount: number;
}

export function parseTierConfig(json: string): TierConfig[] {
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
export function planByRating(
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

export interface BuildSeasonInput {
  roundId: string;
  // Subtitle to set on the season. In populate mode, applied only if it
  // differs from the existing subtitle. null clears it.
  subtitle: string | null;
  // Tier config JSON ([{ name, divisionCount }]). Required in create mode
  // and in populate mode when the existing season has no tiers yet.
  config?: string;
  // Create-mode knobs (ignored in populate mode).
  targetGroupSize?: number;
  minGroupSize?: number;
  matchConfigPresetId?: string | null;
  // Stamps the audit entry so we can tell UI vs script-triggered builds.
  actor: AuditActor;
}

export interface BuildSeasonResult {
  seasonId: string;
  seasonNumber: number;
  mode: "create" | "populate";
  divisionCount: number;
  playersPlaced: number;
}

// Returns null when the build can't proceed (no round, no tier shape,
// season vanished) — same early-return points as the original action.
export async function buildSeasonFromRound(input: BuildSeasonInput): Promise<BuildSeasonResult | null> {
  const { roundId, subtitle, actor } = input;
  if (!roundId) return null;

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return null;

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
  let mode: "create" | "populate";

  if (round.resultingSeasonId) {
    // Populate-existing mode
    mode = "populate";
    const existing = await prisma.season.findUnique({
      where: { id: round.resultingSeasonId },
      include: {
        tiers: { orderBy: { position: "asc" } },
        divisions: { orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }], include: { tier: true } },
      },
    });
    if (!existing) return null;

    if (subtitle !== existing.subtitle) {
      await prisma.season.update({ where: { id: existing.id }, data: { subtitle } });
    }

    // If the season has no tiers yet (admin deferred shape until after
    // signups closed), create them now from the supplied tier config.
    if (existing.tiers.length === 0) {
      const formTiers = parseTierConfig(input.config ?? "");
      if (formTiers.length === 0) return null;
      for (let i = 0; i < formTiers.length; i++) {
        const c = formTiers[i]!;
        const tier = await prisma.tier.create({
          data: { seasonId: existing.id, position: i + 1, name: c.name },
        });
        for (let g = 1; g <= c.divisionCount; g++) {
          // Card-themed: the first (strongest) division in a tier is the Ace
          // ("Tier A"), then 2, 3, 4, 5… Single-division tiers stay unnumbered.
          const divisionName = c.divisionCount === 1 ? c.name : `${c.name} ${g === 1 ? "A (1)" : g}`;
          await prisma.division.create({
            data: { seasonId: existing.id, tierId: tier.id, groupNumber: g, name: divisionName },
          });
        }
      }
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
    // Create-new mode
    mode = "create";
    const tiers = parseTierConfig(input.config ?? "");
    if (tiers.length === 0) return null;

    const targetGroupSize = Math.max(2, input.targetGroupSize ?? 5);
    const minGroupSize = Math.max(2, input.minGroupSize ?? 3);
    const matchConfigPresetId = input.matchConfigPresetId ?? null;

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
        isActive: false,
        targetGroupSize,
        minGroupSize,
        matchConfigPresetId,
      },
    });

    for (const planTier of plan) {
      const tier = await prisma.tier.create({
        data: { seasonId: season.id, position: planTier.position, name: planTier.tier.name },
      });
      for (let gi = 0; gi < planTier.divisions.length; gi++) {
        const memberDiscordIds = planTier.divisions[gi]!;
        // Card-themed: first (strongest) division in a tier is the Ace, then 2…
        const divisionName =
          planTier.tier.divisionCount === 1 && gi === 0
            ? planTier.tier.name
            : `${planTier.tier.name} ${gi === 0 ? "A (1)" : gi + 1}`;
        const division = await prisma.division.create({
          data: { seasonId: season.id, tierId: tier.id, groupNumber: gi + 1, name: divisionName },
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
    actor,
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

  return {
    seasonId: targetSeasonId,
    seasonNumber: finalShape?.number ?? 0,
    mode,
    divisionCount: finalShape?.divisions.length ?? 0,
    playersPlaced: players.length,
  };
}
