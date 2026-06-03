"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { runMatchSweep } from "@/lib/match-sweep";
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
  const { user } = await requireAdmin();
  const discordRoleId = String(formData.get("discordRoleId") ?? "").trim();
  const tierRaw = String(formData.get("tier") ?? "").trim();
  if (!/^\d{17,20}$/.test(discordRoleId)) return;
  if (tierRaw !== "OWNER" && tierRaw !== "ADMIN" && tierRaw !== "MOD") return;
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
  const { user } = await requireAdmin();
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

// Manual trigger for the match-thread sweep. Same three passes that
// run every minute on the bot, but callable on demand from the admin
// page — useful when the bot is down or admin wants to flush
// immediately. Records audit so the trigger is traceable.
export async function runMatchSweepAction() {
  const { user } = await requireAdmin();
  const result = await runMatchSweep();
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "match-sweep.manual",
    targetType: "MatchSession",
    targetId: "all",
    summary:
      `Manual match-thread sweep: ${result.expiredInvitesCancelled} expired invite(s), ` +
      `${result.idleSessionsCancelled} idle session(s), ${result.leakedThreadsProcessed} leaked thread(s) processed ` +
      `(${result.leakedThreadsDeleted} deleted)`,
    metadata: { ...result },
  });
  revalidatePath("/admin/config");
  const summary = encodeURIComponent(
    `Expired invites: ${result.expiredInvitesCancelled} · Idle: ${result.idleSessionsCancelled} · Leaked: ${result.leakedThreadsDeleted}/${result.leakedThreadsProcessed}`,
  );
  redirect(`/admin/config?sweepOk=${summary}`);
}
