"use server";

// Server actions for /admin/settings (rules-template manager). Locked
// to OWNER + DEVOPS — scoring + ban/pick are constants now, so the
// only writable fields are the two timeout values.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireOwnerOrDevops } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { invalidateLeagueSettingsCache } from "@/lib/league-settings";
import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

const NUMERIC_FIELDS = [
  ["matchInviteExpiryMinutes", 1],
  ["reportAutoConfirmSeconds", 1],
] as const;

function parseFields(formData: FormData): { values: Record<string, number>; error: string | null } {
  const values: Record<string, number> = {};
  for (const [name, min] of NUMERIC_FIELDS) {
    const raw = formData.get(name);
    const n = parseInt(String(raw ?? ""), 10);
    if (!Number.isFinite(n) || n < min) {
      return { values, error: `${name} must be an integer >= ${min}` };
    }
    values[name] = n;
  }
  return { values, error: null };
}

export async function saveRulesTemplate(formData: FormData) {
  const { user } = await requireOwnerOrDevops();
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/admin/settings?err=name-required");

  const { values, error } = parseFields(formData);
  if (error) redirect(`/admin/settings?err=${encodeURIComponent(error)}`);

  const data = { name, ...values };
  let resultId: string;
  if (id) {
    const updated = await prisma.leagueRulesTemplate.update({ where: { id }, data });
    resultId = updated.id;
  } else {
    const created = await prisma.leagueRulesTemplate.create({ data });
    resultId = created.id;
  }
  invalidateLeagueSettingsCache();
  recordAudit({
    actor: actorFromAdminUser(user),
    action: id ? "rules-template.update" : "rules-template.create",
    targetType: "LeagueRulesTemplate",
    targetId: resultId,
    summary: `${id ? "Updated" : "Created"} rules template "${name}"`,
    metadata: values,
  });

  revalidatePath("/admin/settings");
  redirect("/admin/settings?ok=1");
}

export async function setDefaultRulesTemplate(formData: FormData) {
  const { user } = await requireOwnerOrDevops();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const tpl = await prisma.leagueRulesTemplate.findUnique({ where: { id } });
  if (!tpl) return;
  await prisma.$transaction([
    prisma.leagueRulesTemplate.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    prisma.leagueRulesTemplate.update({ where: { id }, data: { isDefault: true } }),
  ]);
  invalidateLeagueSettingsCache();
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "rules-template.set-default",
    targetType: "LeagueRulesTemplate",
    targetId: id,
    summary: `Set "${tpl.name}" as the default rules template`,
  });
  revalidatePath("/admin/settings");
}

export async function deleteRulesTemplate(formData: FormData) {
  const { user } = await requireOwnerOrDevops();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const tpl = await prisma.leagueRulesTemplate.findUnique({
    where: { id },
    include: { _count: { select: { seasons: true } } },
  });
  if (!tpl) return;
  if (tpl.isDefault) {
    redirect(`/admin/settings?err=${encodeURIComponent("Can't delete the default template — set another as default first.")}`);
  }
  if (tpl._count.seasons > 0) {
    redirect(`/admin/settings?err=${encodeURIComponent(`Template is used by ${tpl._count.seasons} season(s) — point them elsewhere first.`)}`);
  }
  await prisma.leagueRulesTemplate.delete({ where: { id } });
  invalidateLeagueSettingsCache();
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "rules-template.delete",
    targetType: "LeagueRulesTemplate",
    targetId: id,
    summary: `Deleted rules template "${tpl.name}"`,
  });
  revalidatePath("/admin/settings");
}

// Per-season picker. Stays available to ADMINs (not just DevOps) —
// picking which existing rules template a season uses is league-mgmt,
// not infra.
export async function setSeasonRulesTemplate(formData: FormData) {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("seasonId") ?? "").trim();
  const templateIdRaw = String(formData.get("leagueRulesTemplateId") ?? "").trim();
  if (!seasonId) return;
  const leagueRulesTemplateId = templateIdRaw === "" ? null : templateIdRaw;
  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { number: true, subtitle: true } });
  await prisma.season.update({ where: { id: seasonId }, data: { leagueRulesTemplateId } });
  invalidateLeagueSettingsCache();
  if (season) {
    let templateName = "default";
    if (leagueRulesTemplateId) {
      const tpl = await prisma.leagueRulesTemplate.findUnique({ where: { id: leagueRulesTemplateId }, select: { name: true } });
      templateName = tpl?.name ?? leagueRulesTemplateId;
    }
    recordAudit({
      actor: actorFromAdminUser(user),
      action: "season.set-rules-template",
      targetType: "Season",
      targetId: seasonId,
      summary: `"${formatSeasonLabel(season)}" rules template: ${templateName}`,
      metadata: { leagueRulesTemplateId },
    });
  }
  revalidatePath(`/seasons/${seasonId}`);
}
