import "server-only";

// One drop path for every button that drops a player mid-season (the
// profile's admin card and the division page's member list). Marks the
// membership DROPPED, voids the leaver's unplayed matches, refills their
// opponents when asked (never past anyone's slate), works out how many
// results count from now on under best-N scoring, and tells the whole
// division: the affected players get exactly what changed, everyone else
// gets the notice that nothing of theirs moved.

import { prisma } from "@/lib/prisma";
import { captureDivisionPairings } from "@/lib/schedule-regenerate";
import { diffOpponents } from "@/lib/schedule-diff-core";
import { enqueueScheduleChange, enqueueStandingsRefresh } from "@/lib/queue";
import { getPlacementRules } from "@/lib/placement-rules";
import { scheduleDegree } from "@/lib/schedule";
import { resyncSeasonSchedules } from "@/lib/schedule-sync";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { recordAudit, type AuditActor } from "@/lib/audit";

export interface DropPlayerArgs {
  playerId: string;
  divisionId: string;
  seasonId: string;
  // Draw replacement matchups for the leaver's opponents (true) or leave
  // them one match short (false).
  refill: boolean;
  reason?: string | null;
  actor: AuditActor;
}

export type DropPlayerResult =
  | { outcome: "not-a-member" }
  | { outcome: "dropped"; name: string; voided: number; created: number; told: number; countBest: number | null };

export async function dropPlayerFromDivision(args: DropPlayerArgs): Promise<DropPlayerResult> {
  const { playerId, divisionId, seasonId, refill, actor } = args;
  const reason = args.reason?.trim() || null;

  const membership = await prisma.divisionMember.findUnique({
    where: { divisionId_playerId: { divisionId, playerId } },
  });
  if (!membership || membership.status !== "ACTIVE") return { outcome: "not-a-member" };

  // Snapshot the slate before anything is deleted so the change DMs can say
  // exactly whose matchups were removed or replaced.
  const pairingsBefore = await captureDivisionPairings(divisionId);

  await prisma.divisionMember.update({
    where: { id: membership.id },
    data: { status: "DROPPED", droppedAt: new Date(), dropoutReason: reason },
  });

  // Void unplayed pairings; played ones stand.
  const voided = await prisma.match.deleteMany({
    where: { divisionId, status: "PENDING", OR: [{ playerAId: playerId }, { playerBId: playerId }] },
  });

  // Under best-N scoring everyone in the division now counts their best
  // N-1 results; work out N-1 so the DMs can say so.
  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { scoringMode: true } });
  const scoring = season?.scoringMode ?? "all";
  let countBest: number | undefined;
  if (scoring.startsWith("best-n")) {
    const [division, rules] = await Promise.all([
      prisma.division.findUnique({
        where: { id: divisionId },
        select: { opponentsPerPlayer: true, members: { select: { status: true } } },
      }),
      getPlacementRules(),
    ]);
    if (division) {
      const active = division.members.filter((m) => m.status === "ACTIVE").length;
      const dropped = division.members.filter((m) => m.status === "DROPPED").length;
      const scheduled = scheduleDegree(division.opponentsPerPlayer, rules.defaultOpponentsPerPlayer, active + dropped);
      countBest = Math.max(0, scheduled - dropped);
    }
  }
  const departed = await prisma.player.findUnique({ where: { id: playerId }, select: { displayName: true } });
  const notice = { departedName: departed?.displayName, countBest };

  // Refill the leaver's ex-opponents toward their slate (never past it) and
  // DM everyone whose matchups changed.
  const resync = await resyncSeasonSchedules(seasonId, {
    beforeByDivision: new Map([[divisionId, pairingsBefore]]),
    fill: refill,
    notice,
  });

  // Everyone else in the division hears the same news once.
  const after = await captureDivisionPairings(divisionId);
  const changedIds = new Set(diffOpponents(pairingsBefore, after).map((c) => c.playerId));
  changedIds.delete(playerId);
  const others = await prisma.divisionMember.findMany({
    where: { divisionId, status: "ACTIVE", playerId: { notIn: [...changedIds] } },
    select: { playerId: true, division: { select: { name: true } } },
  });
  if (others.length > 0) {
    await enqueueScheduleChange({
      recipients: others.map((m) => ({ playerId: m.playerId, role: "notice" as const })),
      divisionName: others[0]!.division.name,
      departedName: notice.departedName,
      countBest,
    }).catch((err) => console.warn("[drop] division notice enqueue failed:", err));
  }

  await recomputeDivisionStandings(divisionId).catch(() => {});
  await enqueueStandingsRefresh().catch(() => {});
  await recordAudit({
    actor,
    action: "division.drop",
    targetType: "DivisionMember",
    targetId: membership.id,
    summary: `${reason ? `Dropped (${reason})` : "Dropped"}${refill ? ", opponents refilled" : ", no new matches"}`,
    metadata: { divisionId, playerId, reason, refill, countBest: countBest ?? null },
  });
  return {
    outcome: "dropped",
    name: departed?.displayName ?? "Player",
    voided: voided.count,
    created: resync.created,
    told: changedIds.size + others.length,
    countBest: countBest ?? null,
  };
}

// One-line summary for the ?ok= callout after a drop.
export function describeDrop(r: Extract<DropPlayerResult, { outcome: "dropped" }>): string {
  const parts = [
    `${r.name} dropped`,
    `${r.voided} unplayed match${r.voided === 1 ? "" : "es"} voided`,
    r.created > 0 ? `${r.created} new matchup${r.created === 1 ? "" : "s"} drawn` : "no new matchups",
    `${r.told} player${r.told === 1 ? "" : "s"} told by DM`,
  ];
  if (r.countBest) parts.push(`division now counts best ${r.countBest}`);
  return parts.join(", ") + ".";
}
