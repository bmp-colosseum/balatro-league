import "server-only";

// Shared helper for the three places a division's schedule gets regenerated
// with no roster change involved (opponents reshuffled, same roster): the
// two manual admin actions in web/app/admin/seasons/actions.ts
// (regenerateSchedules, regenerateDivisionSchedule) and the automatic
// needsCleanRegenerate path in resyncSeasonSchedules. Each caller must
// capture the division's pairings via captureDivisionPairings BEFORE
// deleting + rebuilding its matches, then pass that snapshot to
// notifyScheduleRegenerated afterward so every ACTIVE member whose opponent
// set changed gets a correction DM with their new schedule. Centralizing
// this here means the three call sites can't drift on who gets DM'd.

import { prisma } from "@/lib/prisma";
import { diffOpponents, type Pairing } from "@/lib/schedule-diff-core";
import { enqueueScheduleChange } from "@/lib/queue";

export async function captureDivisionPairings(divisionId: string): Promise<Pairing[]> {
  return prisma.match.findMany({
    where: { divisionId, format: "LEAGUE_BO2" },
    select: { playerAId: true, playerBId: true },
  });
}

// Diffs `before` (captured pre-delete, via captureDivisionPairings) against
// the division's current pairings and enqueues a "regenerated" schedule-
// change DM to every ACTIVE member whose opponent set changed. Returns the
// number of recipients enqueued, for the caller's audit metadata. An enqueue
// failure is caught + logged, not thrown -- a DM outage must never fail the
// regenerate itself.
// `role` picks the DM wording: "regenerated" when the whole slate was redrawn,
// "changed" when a roster change only removed/added a few matchups (the
// patch path in schedule-sync.ts). Either way only players whose opponents
// actually differ are told.
export async function notifyScheduleRegenerated(
  divisionId: string,
  divisionName: string,
  before: Pairing[],
  role: "regenerated" | "changed" = "regenerated",
): Promise<number> {
  const after = await captureDivisionPairings(divisionId);
  const changed = diffOpponents(before, after);
  if (changed.length === 0) return 0;

  const activeMembers = await prisma.divisionMember.findMany({
    where: { divisionId, status: "ACTIVE", playerId: { in: changed.map((c) => c.playerId) } },
    select: { playerId: true },
  });
  const activeIds = new Set(activeMembers.map((m) => m.playerId));
  const recipients = changed
    .filter((c) => activeIds.has(c.playerId))
    .map((c) => ({ playerId: c.playerId, role }));
  if (recipients.length === 0) return 0;

  await enqueueScheduleChange({ recipients, divisionName }).catch((err) =>
    console.warn(`[schedule-regenerate] enqueue failed for division ${divisionId}:`, err),
  );
  return recipients.length;
}
