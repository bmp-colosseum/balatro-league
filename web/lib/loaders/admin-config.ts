// Loaders for the admin config page (/admin/config). Assumes
// requireAdmin() ran in the page (role bindings are gated OWNER-only in
// the page itself).

import type { LeagueConfig, RoleBinding } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// All LeagueConfig KV rows (the page maps these into a key→value lookup)
// plus the role→tier bindings, in display order.
export async function loadAdminConfigPage(): Promise<{
  configRows: LeagueConfig[];
  roleBindings: RoleBinding[];
}> {
  const [configRows, roleBindings] = await Promise.all([
    prisma.leagueConfig.findMany(),
    prisma.roleBinding.findMany({ orderBy: { tier: "asc" } }),
  ]);
  return { configRows, roleBindings };
}
