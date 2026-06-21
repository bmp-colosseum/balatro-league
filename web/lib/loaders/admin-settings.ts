// Loader for the rules-templates manager (/admin/settings). Assumes the
// page already gated on requireOwnerOrDevops().

import { prisma } from "@/lib/prisma";

// All league rules templates with their season-usage count, default first
// then alphabetical.
export async function loadRulesTemplates() {
  return prisma.leagueRulesTemplate.findMany({
    include: { _count: { select: { seasons: true } } },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
}
