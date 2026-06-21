// Loaders for the admin audit-log page (/admin/audit). Assumes
// requireAdmin() ran in the page. The page parses its filters into a
// Prisma where-clause and passes it here; these loaders own the actual
// queries (the slow filter-dropdown + total scans are cached, the page
// rows stay live).

import type { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";

// The filter-dropdown lists (distinct actors/actions/targets) and the unfiltered
// total require full scans of the audit table — expensive and slow-changing, so
// cache them. The paginated page rows stay live (cursor-based, indexed).
export const loadAuditFilterOptions = unstable_cache(
  async () => {
    const [actorRows, actionRows, targetRows] = await Promise.all([
      prisma.adminAuditEvent.findMany({
        distinct: ["actorDiscordId"],
        select: { actorDiscordId: true, actorName: true },
        orderBy: { actorName: "asc" },
        take: 200,
      }),
      prisma.adminAuditEvent.findMany({
        distinct: ["action"],
        select: { action: true },
        orderBy: { action: "asc" },
        take: 200,
      }),
      prisma.adminAuditEvent.findMany({
        distinct: ["targetType"],
        where: { targetType: { not: null } },
        select: { targetType: true },
        orderBy: { targetType: "asc" },
        take: 200,
      }),
    ]);
    return { actorRows, actionRows, targetRows };
  },
  ["audit-filter-options"],
  { revalidate: 300, tags: ["audit"] },
);

export const loadAuditTotalCount = unstable_cache(
  async () => prisma.adminAuditEvent.count(),
  ["audit-total-count"],
  { revalidate: 60, tags: ["audit"] },
);

// This page's rows — the live, indexed bit. `take` is PAGE_SIZE + 1 so the
// caller can detect whether a next page exists.
export async function loadAuditEvents(where: Prisma.AdminAuditEventWhereInput, take: number) {
  return prisma.adminAuditEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
  });
}

// Exact filtered count — only computed when a filter is actually applied.
export async function loadAuditFilteredCount(where: Prisma.AdminAuditEventWhereInput) {
  return prisma.adminAuditEvent.count({ where });
}
