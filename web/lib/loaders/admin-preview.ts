// Loaders for the placement-preview page (/admin/signups/[id]/preview).
// Assumes requireAdmin() ran in the page. These are small control-flow
// reads the page uses to decide which view (fresh sort / continuity
// projection / editable draft arranger) to render.

import { prisma } from "@/lib/prisma";

export interface PreviewRound {
  id: string;
  name: string;
  resultingSeasonId: string | null;
  status: string;
}

// The signup round being previewed (or null if it doesn't exist).
export async function loadPreviewRound(roundId: string): Promise<PreviewRound | null> {
  return prisma.signupRound.findUnique({
    where: { id: roundId },
    select: { id: true, name: true, resultingSeasonId: true, status: true },
  });
}

// Lifecycle flags for the round's resulting season — used to decide whether
// it's a still-editable draft or a live/ended season that redirects away.
export async function loadSeasonLifecycle(
  seasonId: string,
): Promise<{ isActive: boolean; endedAt: Date | null } | null> {
  return prisma.season.findUnique({
    where: { id: seasonId },
    select: { isActive: true, endedAt: true },
  });
}

// How many members the draft season has — non-zero means the editable
// arranger should render.
export async function loadDraftMemberCount(seasonId: string): Promise<number> {
  return prisma.divisionMember.count({ where: { seasonId } });
}
