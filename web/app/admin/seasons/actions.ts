"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { computeRatingDeltas, type DivisionForRating } from "@/lib/end-season";
import { computeStandings } from "@/lib/standings";

interface TierConfig {
  name: string;
  divisionCount: number;
}

const LAST_USED_NAME = "Last used";

function parseConfig(json: string): TierConfig[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((e) => ({
        name: String(e?.name ?? "").trim(),
        divisionCount: Math.max(1, Math.min(50, Math.floor(Number(e?.divisionCount)))) || 1,
      }))
      .filter((t) => t.name.length > 0);
  } catch {
    return [];
  }
}

function defaultDivisionNames(tier: TierConfig): string[] {
  if (tier.divisionCount === 1) return [tier.name];
  return Array.from({ length: tier.divisionCount }, (_, i) => `${tier.name} ${i + 1}`);
}

export async function createSeason(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const configs = parseConfig(String(formData.get("config") ?? ""));
  const total = configs.reduce((sum, t) => sum + t.divisionCount, 0);
  if (total === 0) return;

  let deadline: Date | null = null;
  const deadlineStr = String(formData.get("deadline") ?? "");
  if (deadlineStr) {
    const d = new Date(deadlineStr + "Z");
    if (!Number.isNaN(d.getTime())) deadline = d;
  }

  const targetGroupSize = Math.max(2, parseInt(String(formData.get("targetGroupSize")), 10) || 5);
  const minGroupSize = Math.max(2, parseInt(String(formData.get("minGroupSize")), 10) || 3);
  const visibility = formData.get("visibility") === "INTERNAL" ? "INTERNAL" : "PUBLIC";

  const season = await prisma.season.create({
    data: { name, deadline, isActive: false, targetGroupSize, minGroupSize, visibility },
  });

  for (let i = 0; i < configs.length; i++) {
    const c = configs[i]!;
    const tier = await prisma.tier.create({
      data: { seasonId: season.id, position: i + 1, name: c.name },
    });
    const names = defaultDivisionNames(c);
    for (let g = 1; g <= c.divisionCount; g++) {
      await prisma.division.create({
        data: { seasonId: season.id, tierId: tier.id, groupNumber: g, name: names[g - 1]! },
      });
    }
  }

  // Save layout as Last used template
  await prisma.tierTemplate.upsert({
    where: { name: LAST_USED_NAME },
    create: { name: LAST_USED_NAME, config: JSON.stringify(configs), isLastUsed: true },
    update: { config: JSON.stringify(configs), isLastUsed: true },
  });

  revalidatePath("/admin/seasons");
}

export async function activateSeason(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const target = await prisma.season.findUnique({ where: { id } });
  if (!target) return;
  const prior = await prisma.season.findFirst({
    where: { isActive: true, visibility: target.visibility, NOT: { id } },
  });
  if (prior) {
    await prisma.season.update({
      where: { id: prior.id },
      data: { isActive: false, endedAt: new Date() },
    });
  }
  await prisma.season.update({ where: { id }, data: { isActive: true, endedAt: null } });
  revalidatePath("/admin/seasons");
}

export async function saveTemplate(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("templateName") ?? "").trim();
  const configJson = String(formData.get("config") ?? "");
  if (!name) return;
  const configs = parseConfig(configJson);
  if (configs.length === 0) return;
  await prisma.tierTemplate.upsert({
    where: { name },
    create: { name, config: JSON.stringify(configs), isLastUsed: false },
    update: { config: JSON.stringify(configs) },
  });
  revalidatePath("/admin/seasons");
  revalidatePath("/admin/seasons/templates");
}

export async function deleteTemplate(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await prisma.tierTemplate.delete({ where: { id } });
  revalidatePath("/admin/seasons/templates");
}

// End a season: compute new ratings from final standings, write them back to
// Players, mark Season inactive + endedAt now. Idempotent on the inactive
// flag — clicking on an already-inactive season is a no-op for the season
// state but still recomputes ratings.
export async function endSeason(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const season = await prisma.season.findUnique({
    where: { id },
    include: {
      tiers: { orderBy: { position: "asc" } },
      divisions: {
        include: {
          tier: true,
          members: {
            include: { player: true },
          },
          pairings: { where: { status: "CONFIRMED" } },
        },
      },
    },
  });
  if (!season) return;

  const divisionsForRating: DivisionForRating[] = season.divisions.map((d) => {
    const players = d.members.map((m) => m.player);
    return {
      tierPosition: d.tier.position,
      members: d.members.map((m) => ({
        playerId: m.playerId,
        status: m.status,
        currentRating: m.player.rating,
      })),
      standings: computeStandings(players, d.pairings),
    };
  });

  const numTiers = season.tiers.length;
  const deltas = computeRatingDeltas(numTiers, divisionsForRating);

  // Apply rating updates in a single transaction so partial failure doesn't
  // leave the league half-rated.
  await prisma.$transaction([
    ...deltas.map((d) =>
      prisma.player.update({
        where: { id: d.playerId },
        data: { rating: d.newRating },
      }),
    ),
    prisma.season.update({
      where: { id: season.id },
      data: { isActive: false, endedAt: new Date() },
    }),
  ]);

  revalidatePath("/admin/seasons");
  revalidatePath("/admin/rankings");
  redirect("/admin/seasons");
}

export async function setSeasonVisibility(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const visibilityRaw = String(formData.get("visibility") ?? "");
  if (!id) return;
  const visibility = visibilityRaw === "INTERNAL" ? "INTERNAL" : "PUBLIC";
  await prisma.season.update({ where: { id }, data: { visibility } });
  revalidatePath("/admin/seasons");
}

export async function setSeasonPreset(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const presetIdRaw = String(formData.get("presetId") ?? "");
  if (!id) return;
  // Empty string from the "— Use Default —" option means clear the FK.
  const matchConfigPresetId = presetIdRaw === "" ? null : presetIdRaw;
  await prisma.season.update({ where: { id }, data: { matchConfigPresetId } });
  revalidatePath("/admin/seasons");
}
