// One place for "what season are players currently looking at?" — always the active PUBLIC season.
// INTERNAL seasons are admin-only and never feed into player-facing commands or pages.

import { prisma } from "./db.js";

export function activePublicSeason() {
  return prisma.season.findFirst({ where: { isActive: true, visibility: "PUBLIC" } });
}

// Admin variant — returns any active season regardless of visibility.
// Use only in admin contexts where the admin has chosen which season to operate on.
export function activeAnyVisibilitySeason() {
  return prisma.season.findFirst({ where: { isActive: true }, orderBy: { visibility: "asc" } });
}
