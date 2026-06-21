// Loaders for the build-season page (/admin/signups/[id]/build). Assumes
// requireAdmin() ran in the page. The bulk of the page's data comes from
// loadBuildSeasonPage in admin-seasons; these cover the two extra inline
// reads.

import { prisma } from "@/lib/prisma";
import { nextSeasonNumber } from "@/lib/format-season";

// The number the next created season would get (max existing + 1).
export async function loadNextSeasonNumber(): Promise<number> {
  return nextSeasonNumber(prisma);
}

// Number + subtitle of the season a round builds into (when the round was
// opened from an existing season) — lets the page show "Season N" instead of
// "create Season <next>".
export async function loadExistingSeasonForBuild(
  seasonId: string,
): Promise<{ number: number; subtitle: string | null } | null> {
  return prisma.season.findUnique({
    where: { id: seasonId },
    select: { number: true, subtitle: true },
  });
}
