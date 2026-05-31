"use server";

// Clone a season's roster into a new DRAFT season, applying promo/relegation
// (top 1 of each division up a tier, bottom 1 down) and snake-drafting the
// resulting tier pools into the same number of divisions as the source.
//
// Created with visibility=INTERNAL and isActive=false so it doesn't pollute
// public standings — admin can review in draft mode (see the season detail
// page's draft UI), tweak placements via the "Move to…" dropdowns, then
// either activate or delete. Useful for testing what next season would
// look like without ending the current one.
//
// Source can be ANY season (ended or in-progress). Uses the current
// computed standings — partial standings give partial promo decisions,
// but you can re-clone whenever to recompute.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { computeStandings } from "@/lib/standings";

export async function cloneSeasonAsDraft(formData: FormData) {
  await requireAdmin();
  const sourceId = String(formData.get("sourceSeasonId") ?? "");
  if (!sourceId) return;

  const source = await prisma.season.findUnique({
    where: { id: sourceId },
    include: {
      tiers: {
        orderBy: { position: "asc" },
        include: {
          divisions: {
            orderBy: { groupNumber: "asc" },
            include: {
              members: { where: { status: "ACTIVE" }, include: { player: true } },
              pairings: {
                where: { status: "CONFIRMED" },
                select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
              },
            },
          },
        },
      },
    },
  });
  if (!source) return;
  if (source.tiers.length === 0) return;

  const tierPositions = source.tiers.map((t) => t.position);
  const minPos = Math.min(...tierPositions);
  const maxPos = Math.max(...tierPositions);

  // For each player in the source, compute their target tier position
  // after promo/relegation. We also stash a 'sortKey' used inside the
  // target tier to seed the snake-draft (higher is better placement).
  interface TargetEntry {
    playerId: string;
    sourceTierPosition: number;
    targetTierPosition: number;
    sortKey: number;
  }
  const targets: TargetEntry[] = [];
  for (const tier of source.tiers) {
    for (const div of tier.divisions) {
      const standings = computeStandings(div.members.map((m) => m.player), div.pairings);
      standings.forEach((row, rankIdx) => {
        const rank = rankIdx + 1; // 1-based
        const lastRank = standings.length;
        // Top of division promotes (better tier = lower position number),
        // bottom relegates (higher position number). Edge cases: top tier
        // can't promote, bottom tier can't relegate — they stay.
        let targetTierPosition = tier.position;
        if (rank === 1 && tier.position > minPos) targetTierPosition = tier.position - 1;
        else if (rank === lastRank && tier.position < maxPos) targetTierPosition = tier.position + 1;
        // Sort key inside target tier: prefer promoted-up players first,
        // then strongest finishers. Points DESC inside the same source tier.
        // Multiply by a big number so source-tier rank dominates points.
        const sourceRankPenalty = tier.position * 100_000 + rank;
        targets.push({
          playerId: row.player.id,
          sourceTierPosition: tier.position,
          targetTierPosition,
          sortKey: -sourceRankPenalty, // higher = better for snake-draft input
        });
      });
    }
  }

  // Group by target tier position, then snake-draft into the same number
  // of divisions as the source had for that tier.
  const byTargetTier = new Map<number, TargetEntry[]>();
  for (const t of targets) {
    const arr = byTargetTier.get(t.targetTierPosition) ?? [];
    arr.push(t);
    byTargetTier.set(t.targetTierPosition, arr);
  }

  // Create the new season + tiers + divisions in DRAFT state (visibility
  // INTERNAL, isActive false) so it stays admin-only until activated.
  const newSeasonName = `${source.name} → next (draft)`;
  const newSeason = await prisma.season.create({
    data: {
      name: newSeasonName,
      isActive: false,
      visibility: "INTERNAL",
      targetGroupSize: source.targetGroupSize,
      minGroupSize: source.minGroupSize,
      matchConfigPresetId: source.matchConfigPresetId,
    },
  });
  const memberCreates: Promise<unknown>[] = [];
  for (const sourceTier of source.tiers) {
    const newTier = await prisma.tier.create({
      data: { seasonId: newSeason.id, position: sourceTier.position, name: sourceTier.name },
    });
    const targetDivCount = sourceTier.divisions.length;
    // Source divisions provide naming convention; we recreate the same
    // names so admin can map "old Common 1" to "new Common 1" mentally.
    const sourceDivisionNames = sourceTier.divisions.map((d) => d.name);
    const newDivisions = await Promise.all(
      Array.from({ length: targetDivCount }, (_, i) =>
        prisma.division.create({
          data: {
            seasonId: newSeason.id,
            tierId: newTier.id,
            groupNumber: i + 1,
            name: sourceDivisionNames[i] ?? `${sourceTier.name} ${i + 1}`,
          },
        }),
      ),
    );

    const playersForTier = (byTargetTier.get(sourceTier.position) ?? [])
      .slice()
      .sort((a, b) => b.sortKey - a.sortKey);
    // Snake-draft: P1→D0, P2→D1, P3→D1, P4→D0, ...
    for (const [idx, entry] of playersForTier.entries()) {
      const round = Math.floor(idx / targetDivCount);
      const slot = idx % targetDivCount;
      const divIdx = round % 2 === 0 ? slot : targetDivCount - 1 - slot;
      const division = newDivisions[divIdx];
      if (!division) continue;
      memberCreates.push(
        prisma.divisionMember.create({
          data: {
            divisionId: division.id,
            seasonId: newSeason.id,
            playerId: entry.playerId,
            status: "ACTIVE",
          },
        }),
      );
    }
  }
  await Promise.all(memberCreates);

  revalidatePath("/admin/seasons");
  revalidatePath(`/admin/seasons/${newSeason.id}`);
  redirect(`/admin/seasons/${newSeason.id}`);
}
