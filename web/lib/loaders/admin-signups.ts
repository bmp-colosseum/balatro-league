// Loaders for the admin signups index (/admin/signups). Assumes
// requireAdmin() ran in the page.

import { prisma } from "@/lib/prisma";

// Every signup round, most-recently opened first, with a non-withdrawn
// signup count surfaced as a `signups` list (Prisma _count can't take a
// `where`, so we shape it via a filtered relation select).
export async function loadSignupRoundsIndex() {
  const rounds = await prisma.signupRound.findMany({
    orderBy: { openedAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      openedAt: true,
      resultingSeasonId: true,
      signups: { where: { withdrawn: false }, select: { id: true } },
    },
  });
  // resultingSeasonId is a bare scalar (no Prisma relation on SignupRound), so
  // fetch the built seasons' ended-state separately — lets the index show
  // "ENDED" instead of a perpetual "BUILT" once the season it built has finished.
  const seasonIds = rounds.map((r) => r.resultingSeasonId).filter((id): id is string => !!id);
  const endedById = new Map<string, Date | null>();
  if (seasonIds.length > 0) {
    const seasons = await prisma.season.findMany({
      where: { id: { in: seasonIds } },
      select: { id: true, endedAt: true },
    });
    for (const s of seasons) endedById.set(s.id, s.endedAt);
  }
  return rounds.map((r) => ({
    ...r,
    resultingSeasonEndedAt: r.resultingSeasonId ? endedById.get(r.resultingSeasonId) ?? null : null,
  }));
}
