// Loaders for the hidden-MMR admin page (/admin/mmr). Assumes
// requireAdmin() ran in the page.

import { prisma } from "@/lib/prisma";

// Whether live MMR is enabled (the sweep auto-updates MMR on each confirmed
// match). Stored as the string "true" in LeagueConfig.
export async function loadLiveMmrEnabled(): Promise<boolean> {
  return (
    (await prisma.leagueConfig.findUnique({ where: { key: "live_mmr_enabled" } }))?.value === "true"
  );
}
