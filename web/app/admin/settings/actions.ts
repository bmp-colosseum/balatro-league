"use server";

// Server action for /admin/settings. Validates input, writes all keys
// in one transaction, invalidates the in-process settings cache, and
// triggers a standings recompute (since scoring changes ripple through
// every cached row).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { invalidateLeagueSettingsCache } from "@/lib/league-settings";
import { prisma } from "@/lib/prisma";
import { recomputeDivisionStandings } from "@/lib/standings-cache";

const CONFIG_KEYS = {
  PointsFor20Win: "points_for_2_0_win",
  PointsFor11Draw: "points_for_1_1_draw",
  PointsForLoss: "points_for_loss",
  FirstPlayerBans: "first_player_bans",
  SecondPlayerBans: "second_player_bans",
  MatchPoolSize: "match_pool_size",
  MatchInviteExpiryMinutes: "match_invite_expiry_minutes",
  ReportAutoConfirmSeconds: "report_auto_confirm_seconds",
} as const;

export async function saveLeagueSettings(formData: FormData) {
  const { user } = await requireAdmin();
  const updatedBy = user.discordId;

  const fields: Array<[keyof typeof CONFIG_KEYS, number, number]> = [
    ["PointsFor20Win", parseInt(String(formData.get("PointsFor20Win") ?? ""), 10), 0],
    ["PointsFor11Draw", parseInt(String(formData.get("PointsFor11Draw") ?? ""), 10), 0],
    ["PointsForLoss", parseInt(String(formData.get("PointsForLoss") ?? ""), 10), 0],
    ["FirstPlayerBans", parseInt(String(formData.get("FirstPlayerBans") ?? ""), 10), 1],
    ["SecondPlayerBans", parseInt(String(formData.get("SecondPlayerBans") ?? ""), 10), 0],
    ["MatchPoolSize", parseInt(String(formData.get("MatchPoolSize") ?? ""), 10), 3],
    ["MatchInviteExpiryMinutes", parseInt(String(formData.get("MatchInviteExpiryMinutes") ?? ""), 10), 1],
    ["ReportAutoConfirmSeconds", parseInt(String(formData.get("ReportAutoConfirmSeconds") ?? ""), 10), 0],
  ];
  for (const [name, value, min] of fields) {
    if (!Number.isFinite(value) || value < min) {
      redirect(`/admin/settings?err=${encodeURIComponent(`${name} must be an integer >= ${min}`)}`);
    }
  }
  // Cross-field sanity: pool must leave at least 1 combo to pick from.
  const first = fields.find((f) => f[0] === "FirstPlayerBans")![1];
  const second = fields.find((f) => f[0] === "SecondPlayerBans")![1];
  const pool = fields.find((f) => f[0] === "MatchPoolSize")![1];
  if (pool - first - second < 1) {
    redirect(`/admin/settings?err=${encodeURIComponent("Pool size must leave at least 1 combo after both players ban")}`);
  }

  await prisma.$transaction(
    fields.map(([name, value]) =>
      prisma.leagueConfig.upsert({
        where: { key: CONFIG_KEYS[name] },
        create: { key: CONFIG_KEYS[name], value: String(value), updatedBy },
        update: { value: String(value), updatedBy },
      }),
    ),
  );
  invalidateLeagueSettingsCache();
  recordAudit({
    actor: actorFromAdminUser(user),
    action: "league-settings.save",
    summary: "Updated league rules (scoring + ban policy)",
    metadata: Object.fromEntries(fields.map(([name, value]) => [name, value])),
  });

  // Scoring change ⇒ standings cache is now stale. Recompute every
  // active-season division so /standings reflects the new rules
  // without waiting for the next pairing write.
  const activeDivisions = await prisma.division.findMany({
    where: { season: { isActive: true } },
    select: { id: true },
  });
  for (const d of activeDivisions) {
    await recomputeDivisionStandings(d.id).catch(() => {});
  }

  revalidatePath("/admin/settings");
  revalidatePath("/standings");
  redirect("/admin/settings?ok=1");
}
