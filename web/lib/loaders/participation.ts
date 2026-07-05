import "server-only";

// Active-season participation: for every ACTIVE member, how many of their
// scheduled "sets" (LEAGUE_BO2 matches) they've PLAYED vs their total — so an
// admin can spot no-shows (0 played) and stragglers (unfinished) and act. Total
// scheduled respects the schedule format: locked = their assigned matches;
// round-robin = (active members − 1). Mirrors the standings/expected-match logic.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";
import { isScheduleLocked } from "@/lib/schedule-locked";
import { isActiveBan, nextSeasonNumber } from "@/lib/bans";

export type MemberStatus = "no-show" | "incomplete" | "done";
export interface ParticipationMember {
  playerId: string;
  displayName: string;
  discordId: string;
  divisionName: string;
  played: number;
  total: number;
  remaining: number;
  status: MemberStatus;
  banned: boolean;
  strikeCount: number;
}
export interface ParticipationData {
  seasonLabel: string | null;
  members: ParticipationMember[]; // worst-first
  counts: { noShow: number; incomplete: number; done: number; total: number };
}

const STATUS_RANK: Record<MemberStatus, number> = { "no-show": 0, incomplete: 1, done: 2 };

export async function loadParticipation(): Promise<ParticipationData> {
  const [season, nextSeason] = await Promise.all([
    prisma.season.findFirst({
      where: { isActive: true },
      select: {
        number: true,
        subtitle: true,
        scheduleLocked: true,
        divisions: {
          orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
          select: {
            id: true,
            name: true,
            members: {
              where: { status: "ACTIVE" },
              select: {
                playerId: true,
                player: {
                  select: {
                    id: true,
                    displayName: true,
                    discordId: true,
                    bannedAt: true,
                    banLiftsAtSeasonNumber: true,
                    _count: { select: { strikes: true } },
                  },
                },
              },
            },
            matches: {
              where: { format: "LEAGUE_BO2" },
              select: { playerAId: true, playerBId: true, status: true, gamesWonA: true, gamesWonB: true },
            },
          },
        },
      },
    }),
    nextSeasonNumber(),
  ]);
  if (!season) return { seasonLabel: null, members: [], counts: { noShow: 0, incomplete: 0, done: 0, total: 0 } };

  const members: ParticipationMember[] = [];
  for (const d of season.divisions) {
    const activeIds = new Set(d.members.map((m) => m.playerId));
    const locked = isScheduleLocked(season.scheduleLocked, d.matches);
    const played = new Map<string, number>();
    const scheduled = new Map<string, number>();
    for (const m of d.matches) {
      if (m.status === "CANCELLED") continue; // voided/DQ'd — not a set to play
      for (const pid of [m.playerAId, m.playerBId]) {
        if (!activeIds.has(pid)) continue;
        scheduled.set(pid, (scheduled.get(pid) ?? 0) + 1);
        if (m.status === "CONFIRMED") played.set(pid, (played.get(pid) ?? 0) + 1);
      }
    }
    const rrTotal = Math.max(0, activeIds.size - 1); // round-robin: everyone but yourself

    for (const mem of d.members) {
      const p = mem.player;
      const actualScheduled = scheduled.get(mem.playerId) ?? 0; // real (non-cancelled) match rows
      const total = locked ? actualScheduled : rrTotal;
      const pl = played.get(mem.playerId) ?? 0;
      const remaining = Math.max(0, total - pl);
      // "no-show" only when they ACTUALLY have scheduled sets and played none — so
      // a player whose matches were all cancelled/voided reads as done, not no-show.
      const status: MemberStatus = actualScheduled > 0 && pl === 0 ? "no-show" : remaining > 0 ? "incomplete" : "done";
      members.push({
        playerId: p.id,
        displayName: p.displayName,
        discordId: p.discordId,
        divisionName: d.name,
        played: pl,
        total,
        remaining,
        status,
        banned: isActiveBan({ bannedAt: p.bannedAt, banLiftsAtSeasonNumber: p.banLiftsAtSeasonNumber }, nextSeason),
        strikeCount: p._count.strikes,
      });
    }
  }

  members.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      b.remaining - a.remaining ||
      a.divisionName.localeCompare(b.divisionName) ||
      a.displayName.localeCompare(b.displayName),
  );

  return {
    seasonLabel: formatSeasonLabel(season),
    members,
    counts: {
      noShow: members.filter((m) => m.status === "no-show").length,
      incomplete: members.filter((m) => m.status === "incomplete").length,
      done: members.filter((m) => m.status === "done").length,
      total: members.length,
    },
  };
}
