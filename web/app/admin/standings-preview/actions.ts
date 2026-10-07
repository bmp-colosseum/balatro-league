"use server";

// Server actions for /admin/standings-preview:
//   - applyHypotheticalDropsAction: "Apply these drops" -- drops the
//     currently-ticked what-if players for real through the EXISTING drop
//     service (dropDivisionMember in web/app/divisions/[id]/actions.ts),
//     never a hand-rolled status write. No scoring rule is touched here;
//     this only drops.
//   - setSeasonScoringModeAction: "Use this rule for season N" /
//     "Back to counting every game" -- writes Season.scoringMode, audits
//     it, and recomputes every division's cache in this season so the
//     switch is visible immediately (not on the next roster/match write).

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { actorFromAdminUser, recordAudit } from "@/lib/audit";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { normalizeScoringMode, type SeasonScoringMode } from "@/lib/standings-mode";
import { dropDivisionMember } from "@/app/divisions/[id]/actions";

function backTo(seasonId: string, params: Record<string, string>): string {
  const qs = new URLSearchParams({ season: seasonId, ...params });
  return `/admin/standings-preview?${qs.toString()}`;
}

export async function applyHypotheticalDropsAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const seasonId = String(formData.get("season") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  // Each ticked player arrives as one "divisionId:playerId" pair -- see the
  // hidden inputs the page renders from StandingsPreviewData.selectedDrops.
  const pairs = formData
    .getAll("pair")
    .map((v) => String(v))
    .map((v): [string, string] | null => {
      const sep = v.indexOf(":");
      if (sep < 0) return null;
      const divisionId = v.slice(0, sep);
      const playerId = v.slice(sep + 1);
      return divisionId && playerId ? [divisionId, playerId] : null;
    })
    .filter((p): p is [string, string] => p !== null);

  if (!reason) {
    redirect(backTo(seasonId, { applyErr: "A reason is required to apply drops." }));
  }
  if (pairs.length === 0) {
    redirect(backTo(seasonId, { applyErr: "No players were selected to drop." }));
  }

  for (const [divisionId, playerId] of pairs) {
    const dropFormData = new FormData();
    dropFormData.set("divisionId", divisionId);
    dropFormData.set("playerId", playerId);
    dropFormData.set("reason", reason);
    await dropDivisionMember(dropFormData);
  }

  redirect(backTo(seasonId, { applied: String(pairs.length) }));
}

const VALID_MODES: readonly SeasonScoringMode[] = ["all", "best-n-count", "best-n-void"];

export async function setSeasonScoringModeAction(formData: FormData): Promise<void> {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("season") ?? "");
  const modeRaw = String(formData.get("mode") ?? "");
  if (!seasonId || !VALID_MODES.includes(modeRaw as SeasonScoringMode)) {
    redirect(backTo(seasonId, { modeErr: "Not a valid scoring rule." }));
  }
  const mode = modeRaw as SeasonScoringMode;

  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { scoringMode: true } });
  if (!season) {
    redirect(backTo(seasonId, { modeErr: "Season not found." }));
  }
  const previousMode = normalizeScoringMode(season.scoringMode);

  await prisma.season.update({ where: { id: seasonId }, data: { scoringMode: mode } });
  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.scoringMode",
    targetType: "Season",
    targetId: seasonId,
    summary: `Scoring mode: ${previousMode} -> ${mode}`,
    metadata: { seasonId, previousMode, mode },
  });

  // Invalidate immediately -- every division in this season, not just
  // already-warm ones, so the switch is visible the instant this redirect
  // lands (not on the next roster/match write).
  const divisions = await prisma.division.findMany({ where: { seasonId }, select: { id: true } });
  await Promise.all(divisions.map((d) => recomputeDivisionStandings(d.id)));

  redirect(backTo(seasonId, { modeOk: mode }));
}
