"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireOwner } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import type { PermissionTier } from "@prisma/client";

// Upsert a LeagueConfig KV row. Empty string clears (parity with the
// 'clear' button — explicit empty input deletes the row).
export async function setConfigValue(formData: FormData) {
  const { user } = await requireAdmin();
  const key = String(formData.get("key") ?? "").trim();
  const value = String(formData.get("value") ?? "").trim();
  if (!key) return;
  const previous = await prisma.leagueConfig.findUnique({ where: { key } });
  if (value === "") {
    await prisma.leagueConfig.deleteMany({ where: { key } });
    if (previous) {
      recordAudit({
        actor: actorFromAdminUser(user),
        action: "config.clear",
        targetType: "LeagueConfig",
        targetId: key,
        summary: `Cleared config key "${key}"`,
        metadata: { previousValue: previous.value },
      });
    }
  } else {
    await prisma.leagueConfig.upsert({
      where: { key },
      create: { key, value, updatedBy: user.discordId },
      update: { value, updatedBy: user.discordId },
    });
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "config.set",
      targetType: "LeagueConfig",
      targetId: key,
      summary: `Set config key "${key}"`,
      metadata: { previousValue: previous?.value ?? null, newValue: value },
    });
  }
  revalidatePath("/admin/config");
}

export async function clearConfigValue(formData: FormData) {
  const { user } = await requireAdmin();
  const key = String(formData.get("key") ?? "").trim();
  if (!key) return;
  const previous = await prisma.leagueConfig.findUnique({ where: { key } });
  await prisma.leagueConfig.deleteMany({ where: { key } });
  if (previous) {
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "config.clear",
      targetType: "LeagueConfig",
      targetId: key,
      summary: `Cleared config key "${key}"`,
      metadata: { previousValue: previous.value },
    });
  }
  revalidatePath("/admin/config");
}

// Add a new role → tier binding. Validates the discord role id shape
// (snowflake) and the tier enum. Unique constraint on discordRoleId
// means re-adding an existing role updates it via upsert.
export async function addRoleBinding(formData: FormData) {
  const { user } = await requireOwner();
  const discordRoleId = String(formData.get("discordRoleId") ?? "").trim();
  const tierRaw = String(formData.get("tier") ?? "").trim();
  if (!/^\d{17,20}$/.test(discordRoleId)) return;
  if (!["OWNER", "ADMIN", "HELPER", "DEVOPS"].includes(tierRaw)) return;
  const tier = tierRaw as PermissionTier;
  await prisma.roleBinding.upsert({
    where: { discordRoleId },
    create: { discordRoleId, tier, createdBy: user.discordId },
    update: { tier, createdBy: user.discordId },
  });
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "role-binding.set",
    targetType: "RoleBinding",
    targetId: discordRoleId,
    summary: `Bound Discord role ${discordRoleId} → ${tier}`,
    metadata: { discordRoleId, tier },
  });
  revalidatePath("/admin/config");
}

export async function removeRoleBinding(formData: FormData) {
  const { user } = await requireOwner();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const previous = await prisma.roleBinding.findUnique({ where: { id } });
  await prisma.roleBinding.delete({ where: { id } });
  if (previous) {
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "role-binding.remove",
      targetType: "RoleBinding",
      targetId: id,
      summary: `Removed role binding (${previous.discordRoleId} → ${previous.tier})`,
      metadata: { discordRoleId: previous.discordRoleId, tier: previous.tier },
    });
  }
  revalidatePath("/admin/config");
}

