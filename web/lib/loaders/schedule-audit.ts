import "server-only";

// Read-only audit: on a locked schedule the only valid league matchups are the
// pre-created assigned pairs. This finds any match SESSION whose player-pair has
// no assigned BO2 match in its division — i.e. a match that was STARTED against
// an off-schedule opponent (the report path always blocked recording these, but
// until the start path was fixed the thread could still be opened). Sessions
// persist after their thread is deleted, so this catches historical ones too.
//
// Shootouts are excluded — tiebreakers aren't pre-scheduled pairings.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

export interface OffScheduleMatch {
  sessionId: string;
  divisionName: string;
  playerA: string;
  playerAId: string;
  playerB: string;
  playerBId: string;
  state: string;
  live: boolean; // still in a non-terminal state (thread may still exist)
  threadId: string | null;
  createdAt: Date;
}

export interface ScheduleAuditResult {
  seasonLabel: string;
  scheduleLocked: boolean;
  leagueSessionCount: number; // non-casual, non-shootout sessions examined
  offSchedule: OffScheduleMatch[];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const TERMINAL = new Set(["COMPLETE", "CANCELLED"]);

export async function loadScheduleAudit(): Promise<ScheduleAuditResult | "NO_SEASON"> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    include: {
      divisions: {
        select: {
          id: true,
          name: true,
          matches: { where: { format: "LEAGUE_BO2" }, select: { playerAId: true, playerBId: true } },
        },
      },
    },
  });
  if (!season) return "NO_SEASON";

  // Per division: display name + the set of assigned (pre-created) BO2 pairs.
  const divInfo = new Map<string, { name: string; assigned: Set<string> }>();
  for (const d of season.divisions) {
    divInfo.set(d.id, {
      name: d.name,
      assigned: new Set(d.matches.map((m) => pairKey(m.playerAId, m.playerBId))),
    });
  }
  const divIds = season.divisions.map((d) => d.id);

  const sessions = await prisma.matchSession.findMany({
    where: { divisionId: { in: divIds }, isCasual: false, isShootout: false },
    select: {
      id: true,
      divisionId: true,
      playerAId: true,
      playerBId: true,
      state: true,
      threadId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const playerIds = [...new Set(sessions.flatMap((s) => [s.playerAId, s.playerBId]))];
  const players = playerIds.length
    ? await prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, displayName: true } })
    : [];
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));

  const offSchedule: OffScheduleMatch[] = [];
  for (const s of sessions) {
    if (!s.divisionId) continue;
    const info = divInfo.get(s.divisionId);
    if (!info) continue;
    if (info.assigned.has(pairKey(s.playerAId, s.playerBId))) continue; // scheduled — fine
    offSchedule.push({
      sessionId: s.id,
      divisionName: info.name,
      playerA: nameOf.get(s.playerAId) ?? s.playerAId,
      playerAId: s.playerAId,
      playerB: nameOf.get(s.playerBId) ?? s.playerBId,
      playerBId: s.playerBId,
      state: s.state,
      live: !TERMINAL.has(s.state),
      threadId: s.threadId,
      createdAt: s.createdAt,
    });
  }

  return {
    seasonLabel: formatSeasonLabel(season),
    scheduleLocked: season.scheduleLocked,
    leagueSessionCount: sessions.length,
    offSchedule,
  };
}
