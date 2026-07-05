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
import { formatSeasonLabel, formatDivisionName, nextSeasonNumber } from "@/lib/format-season";
import { isActiveBan } from "@/lib/bans";
import { parseTierConfig, planByRating, type TierConfig } from "@/lib/season-plan";

// Re-exported so existing importers of these from build-season keep working.
export { parseTierConfig, planByRating };
export type { TierConfig };

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

  const upserted = await Promise.all(
    round.signups.map((s) =>
      prisma.player.upsert({
        where: { discordId: s.discordId },
        create: { discordId: s.discordId, displayName: s.displayName },
        update: { displayName: s.displayName },
      }),
    ),
  );
  // Banned players are dropped from the build entirely — they don't get planned
  // or placed, even if a stale signup exists. Respects temp-ban expiry.
  const nextSeason = await nextSeasonNumber(prisma);
  const players = upserted.filter((p) => !isActiveBan(p, nextSeason));
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
          const divisionName = formatDivisionName(c.name, g, c.divisionCount);
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
        const divisionName = formatDivisionName(planTier.tier.name, gi + 1, planTier.tier.divisionCount);
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
