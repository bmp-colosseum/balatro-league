// Loaders for the admin signups index (/admin/signups). Assumes
// requireAdmin() ran in the page.

import { prisma } from "@/lib/prisma";

// Every signup round, most-recently opened first, with a non-withdrawn
// signup count surfaced as a `signups` list (Prisma _count can't take a
// `where`, so we shape it via a filtered relation select).
export async function loadSignupRoundsIndex() {
  return prisma.signupRound.findMany({
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
}
