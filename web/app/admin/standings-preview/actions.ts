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
import { normalizeScoringMode, normalizeTiebreak, type SeasonScoringMode, type SeasonTiebreak } from "@/lib/standings-mode";
import { dropDivisionMember } from "@/app/divisions/[id]/actions";
import { loadShootoutCleanup } from "@/lib/loaders/shootout-cleanup";

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

const VALID_TIEBREAKS: readonly SeasonTiebreak[] = ["chain", "lives"];

// "Break ties by net lives" / "Back to today's tiebreaks" -- writes
// Season.tiebreak, audits it, and recomputes every division's cache in this
// season so the LIVE standings reflect the new tiebreak immediately (not on
// the next roster/match write). Modeled exactly on
// setSeasonScoringModeAction above.
export async function setSeasonTiebreakAction(formData: FormData): Promise<void> {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("season") ?? "");
  const tiebreakRaw = String(formData.get("tiebreak") ?? "");
  if (!seasonId || !VALID_TIEBREAKS.includes(tiebreakRaw as SeasonTiebreak)) {
    redirect(backTo(seasonId, { tiebreakErr: "Not a valid tiebreak." }));
  }
  const tiebreak = tiebreakRaw as SeasonTiebreak;

  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { tiebreak: true } });
  if (!season) {
    redirect(backTo(seasonId, { tiebreakErr: "Season not found." }));
  }
  const previousTiebreak = normalizeTiebreak(season.tiebreak);

  await prisma.season.update({ where: { id: seasonId }, data: { tiebreak } });
  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.tiebreak",
    targetType: "Season",
    targetId: seasonId,
    summary: `Tiebreak: ${previousTiebreak} -> ${tiebreak}`,
    metadata: { seasonId, previousTiebreak, tiebreak },
  });

  const divisions = await prisma.division.findMany({ where: { seasonId }, select: { id: true } });
  await Promise.all(divisions.map((d) => recomputeDivisionStandings(d.id)));

  redirect(backTo(seasonId, { tiebreakOk: tiebreak }));
}

// "Convert to lives tiebreak + remove N" -- the shootout clean-up tool's
// one-click action. Switches Season.tiebreak to "lives" (if it isn't
// already) AND deletes every admin-recorded shootout (see
// resolveTieWithShowdowns in web/lib/match-admin.ts) that the lives
// tiebreak would have decided the same way -- see
// web/lib/shootout-cleanup-core.ts's planShootoutCleanup for exactly which
// ones qualify. The plan is re-loaded server-side here (never trusted from
// the submitted form) so a stale page can't delete something that no
// longer qualifies.
export async function convertSeasonToLivesTiebreakAction(formData: FormData): Promise<void> {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("season") ?? "");
  if (!seasonId) {
    redirect(backTo(seasonId, { shootoutErr: "Season not found." }));
  }

  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { tiebreak: true } });
  if (!season) {
    redirect(backTo(seasonId, { shootoutErr: "Season not found." }));
  }
  const previousTiebreak = normalizeTiebreak(season.tiebreak);

  const plan = await loadShootoutCleanup(seasonId);
  const deleteIds = plan.deletableIds;
  const keptCount = plan.summary.total - deleteIds.length;

  await prisma.$transaction(async (tx) => {
    if (previousTiebreak !== "lives") {
      await tx.season.update({ where: { id: seasonId }, data: { tiebreak: "lives" } });
    }
    if (deleteIds.length > 0) {
      await tx.match.deleteMany({ where: { id: { in: deleteIds } } });
    }
  });

  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.shootout-cleanup",
    targetType: "Season",
    targetId: seasonId,
    summary: `Converted ${plan.season?.label ?? seasonId} to lives tiebreak: removed ${deleteIds.length} admin-recorded shootouts lives decide the same way, kept ${keptCount}`,
    metadata: { seasonId, previousTiebreak, deleted: deleteIds.length, kept: keptCount },
  });

  const divisions = await prisma.division.findMany({ where: { seasonId }, select: { id: true } });
  await Promise.all(divisions.map((d) => recomputeDivisionStandings(d.id)));

  redirect(backTo(seasonId, { shootoutOk: String(deleteIds.length) }));
}

// "Switch to lives and remove ALL recorded shootouts" -- a blunter version
// of convertSeasonToLivesTiebreakAction above for a TO who's decided every
// admin-recorded showdown is redundant now, not just the ones lives happens
// to agree with. Switches Season.tiebreak to "lives" (if it isn't already)
// and deletes EVERY admin-recorded shootout (recordedBy not null, see
// web/lib/shootout-cleanup-core.ts's "player-reported" verdict for the only
// kind kept) regardless of verdict -- lives-disagree, lives-tied, and
// no-lives-data rows are removed right alongside the "same" ones.
// Player-reported shootouts (self-played, not an admin tie-break recording)
// are never touched by either button. Re-loads the plan server-side (never
// trusts the submitted form) for the same reason convertSeasonToLivesTiebreakAction
// does.
export async function convertSeasonToLivesTiebreakRemoveAllAction(formData: FormData): Promise<void> {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("season") ?? "");
  if (!seasonId) {
    redirect(backTo(seasonId, { shootoutErr: "Season not found." }));
  }

  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { tiebreak: true } });
  if (!season) {
    redirect(backTo(seasonId, { shootoutErr: "Season not found." }));
  }
  const previousTiebreak = normalizeTiebreak(season.tiebreak);

  const plan = await loadShootoutCleanup(seasonId);
  const deleteIds = plan.divisions
    .flatMap((d) => d.entries)
    .filter((e) => e.verdict !== "player-reported")
    .map((e) => e.id);
  const keptCount = plan.summary.playerReported;

  await prisma.$transaction(async (tx) => {
    if (previousTiebreak !== "lives") {
      await tx.season.update({ where: { id: seasonId }, data: { tiebreak: "lives" } });
    }
    if (deleteIds.length > 0) {
      await tx.match.deleteMany({ where: { id: { in: deleteIds } } });
    }
  });

  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "season.shootout-cleanup-all",
    targetType: "Season",
    targetId: seasonId,
    summary: `Converted ${plan.season?.label ?? seasonId} to lives tiebreak: removed ALL ${deleteIds.length} admin-recorded shootouts, kept ${keptCount} player-reported`,
    metadata: { seasonId, previousTiebreak, deleted: deleteIds.length, kept: keptCount },
  });

  const divisions = await prisma.division.findMany({ where: { seasonId }, select: { id: true } });
  await Promise.all(divisions.map((d) => recomputeDivisionStandings(d.id)));

  redirect(backTo(seasonId, { shootoutOk: String(deleteIds.length) }));
}

// Per-row "Delete anyway" on a KEPT shootout -- for a TO who's read the
// verdict and decided the recorded shootout should go regardless (e.g. it
// was a mistake). Deletes exactly the one match; does not touch
// Season.tiebreak.
export async function deleteShootoutAction(formData: FormData): Promise<void> {
  const { user } = await requireAdmin();
  const seasonId = String(formData.get("season") ?? "");
  const matchId = String(formData.get("id") ?? "");
  if (!matchId) {
    redirect(backTo(seasonId, { shootoutErr: "Missing shootout id." }));
  }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, divisionId: true, format: true, playerAId: true, playerBId: true, winnerId: true },
  });
  if (!match || match.format !== "SHOOTOUT_BO1") {
    redirect(backTo(seasonId, { shootoutErr: "Shootout not found." }));
  }

  await prisma.match.delete({ where: { id: matchId } });
  await recordAudit({
    actor: actorFromAdminUser(user),
    action: "shootout.delete",
    targetType: "Match",
    targetId: matchId,
    summary: `Deleted shootout between ${match.playerAId} and ${match.playerBId}`,
    metadata: { matchId, divisionId: match.divisionId, playerAId: match.playerAId, playerBId: match.playerBId, winnerId: match.winnerId },
  });
  await recomputeDivisionStandings(match.divisionId);

  redirect(backTo(seasonId, { shootoutOk: "1" }));
}
