"use server";

// Fix buttons for /admin/roles: bulk add/remove a single Discord role to
// close the gap the audit found. Re-derives the current gap from the loader
// on every submit -- never trusts the missing/extra ids the form was
// rendered with, since the audit (and the guild) can move between render
// and click.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { addGuildMemberRole, removeGuildMemberRole } from "@/lib/discord";
import { loadRoleAuditData } from "@/lib/loaders/role-audit";
import type { ActionResult } from "@/lib/action-result";

export async function fixRole(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const { user } = await requireAdmin();
  const roleId = String(formData.get("roleId") ?? "");
  const mode = String(formData.get("mode") ?? "");
  if (!roleId || (mode !== "add-missing" && mode !== "remove-extra")) {
    return { ok: false, message: "Invalid fix request." };
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return { ok: false, message: "DISCORD_GUILD_ID is not configured." };

  const data = await loadRoleAuditData();
  const entry = data.report.entries.find((e) => e.roleId === roleId);
  if (!entry) return { ok: false, message: "That role no longer appears in the audit." };

  const targetIds = mode === "add-missing" ? entry.missing : entry.extra;
  const verb = mode === "add-missing" ? "add" : "remove";
  if (targetIds.length === 0) {
    return { ok: true, message: `${entry.roleName}: nothing to ${verb}.` };
  }

  let succeeded = 0;
  let failed = 0;
  for (const discordId of targetIds) {
    const ok =
      mode === "add-missing"
        ? await addGuildMemberRole(guildId, discordId, roleId)
        : await removeGuildMemberRole(guildId, discordId, roleId);
    if (ok) succeeded++;
    else failed++;
  }

  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "roles.fix",
    targetType: "Role",
    targetId: roleId,
    summary: `${mode === "add-missing" ? "Added" : "Removed"} ${entry.roleName} for ${succeeded} member(s)${failed > 0 ? `, ${failed} failed` : ""}`,
    metadata: { roleId, roleName: entry.roleName, mode, succeeded, failed },
  });

  revalidatePath("/admin/roles");

  const verbed = mode === "add-missing" ? "added" : "removed";
  return {
    ok: failed === 0,
    message: `${entry.roleName}: ${verbed} for ${succeeded} member(s)` + (failed > 0 ? `, ${failed} failed -- see server logs.` : "."),
  };
}
