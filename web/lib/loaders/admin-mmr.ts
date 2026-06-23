// Loaders for the hidden-MMR admin page (/admin/mmr). Assumes
// requireAdmin() ran in the page.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

// Whether live MMR is enabled (the sweep auto-updates MMR on each confirmed
// match). Stored as the string "true" in LeagueConfig.
export async function loadLiveMmrEnabled(): Promise<boolean> {
  return (
    (await prisma.leagueConfig.findUnique({ where: { key: "live_mmr_enabled" } }))?.value === "true"
  );
}

export interface MmrSeasonOption {
  id: string;
  label: string;
  isActive: boolean;
}

// Seasons that have any games to recompute from, for the MMR basis picker.
// Active season first, then most recent. Archived seasons excluded.
export async function loadMmrSeasons(): Promise<MmrSeasonOption[]> {
  const seasons = await prisma.season.findMany({
    where: { archivedAt: null },
    orderBy: [{ isActive: "desc" }, { number: "desc" }],
    select: { id: true, number: true, subtitle: true, isActive: true },
  });
  return seasons.map((s) => ({ id: s.id, label: formatSeasonLabel(s), isActive: s.isActive }));
}
