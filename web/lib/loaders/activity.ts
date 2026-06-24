import "server-only";

// Loader for /admin/activity: the latest activity scan's status + the inactive
// registry (active players who are silent this season AND have no match played
// or attempted). The bot runs the scan; this just reads the ActivityScan row it
// writes and combines it with match activity.

import { prisma } from "@/lib/prisma";

export interface ActivityScanStatus {
  id: string;
  status: string; // RUNNING | DONE | FAILED
  channelsDone: number;
  channelsTotal: number;
  messagesScanned: number;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}

export interface InactiveRow {
  playerId: string;
  discordId: string;
  name: string;
  division: string;
  lastPostMs: number | null; // most recent message, or null = never (in scanned channels)
  played: boolean;
  attempted: boolean;
  playedPrevSeason: boolean; // played a confirmed match in any earlier season (a returning player)
  checkinStatus: string | null; // null | "pending" | "in" | "out" | "dm-failed"
  optedOut: boolean; // signupReminderOptOut — won't be DM'd
}

export interface ActivityData {
  hasSeason: boolean;
  scan: ActivityScanStatus | null;
  // The fully-silent registry, only when the latest scan is DONE. Null otherwise.
  ghosts: InactiveRow[] | null;
  activeTotal: number;
}

export async function loadActivityData(): Promise<ActivityData> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, startedAt: true },
  });
  if (!season) return { hasSeason: false, scan: null, ghosts: null, activeTotal: 0 };

  const latest = await prisma.activityScan.findFirst({
    where: { seasonId: season.id },
    orderBy: { startedAt: "desc" },
  });
  const scan: ActivityScanStatus | null = latest
    ? {
        id: latest.id,
        status: latest.status,
        channelsDone: latest.channelsDone,
        channelsTotal: latest.channelsTotal,
        messagesScanned: latest.messagesScanned,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        error: latest.error,
      }
    : null;

  const members = await prisma.divisionMember.findMany({
    where: { seasonId: season.id, status: "ACTIVE" },
    select: {
      playerId: true,
      checkinStatus: true,
      player: { select: { discordId: true, displayName: true, signupReminderOptOut: true } },
      division: { select: { name: true } },
    },
  });
  const activeTotal = members.length;

  // Only build the registry off a COMPLETED scan (need the chat signal).
  if (!latest || latest.status !== "DONE") {
    return { hasSeason: true, scan, ghosts: null, activeTotal };
  }

  const lastPost = (latest.lastPostByDiscordId ?? {}) as unknown as Record<string, string>;
  const seasonStart = season.startedAt.getTime();
  const playerIds = members.map((m) => m.playerId);
  const divs = await prisma.division.findMany({ where: { seasonId: season.id }, select: { id: true } });
  const divIds = divs.map((d) => d.id);

  const [playedRows, sessionRows] = await Promise.all([
    prisma.match.findMany({
      where: {
        status: "CONFIRMED",
        format: "LEAGUE_BO2",
        divisionId: { in: divIds },
        OR: [{ playerAId: { in: playerIds } }, { playerBId: { in: playerIds } }],
      },
      select: { playerAId: true, playerBId: true },
    }),
    prisma.matchSession.findMany({
      where: { divisionId: { in: divIds }, OR: [{ playerAId: { in: playerIds } }, { playerBId: { in: playerIds } }] },
      select: { playerAId: true, playerBId: true },
    }),
  ]);
  const playedSet = new Set<string>();
  for (const m of playedRows) { playedSet.add(m.playerAId); playedSet.add(m.playerBId); }
  const attemptedSet = new Set<string>();
  for (const s of sessionRows) { attemptedSet.add(s.playerAId); attemptedSet.add(s.playerBId); }

  const baseRows = members
    .map((m) => {
      const iso = lastPost[m.player.discordId];
      const lastPostMs = iso ? new Date(iso).getTime() : null;
      return {
        playerId: m.playerId,
        discordId: m.player.discordId,
        name: m.player.displayName,
        division: m.division.name,
        lastPostMs,
        played: playedSet.has(m.playerId),
        attempted: attemptedSet.has(m.playerId),
        checkinStatus: m.checkinStatus,
        optedOut: m.player.signupReminderOptOut,
      };
    })
    .filter((r) => (r.lastPostMs === null || r.lastPostMs < seasonStart) && !r.played && !r.attempted);

  // Prev-season context — which of these ghosts played a confirmed match in an
  // EARLIER season (a returning player vs a never-played newcomer).
  const ghostIds = baseRows.map((r) => r.playerId);
  const prevPlayedSet = new Set<string>();
  if (ghostIds.length > 0) {
    const prev = await prisma.match.findMany({
      where: {
        status: "CONFIRMED",
        format: "LEAGUE_BO2",
        division: { seasonId: { not: season.id } },
        OR: [{ playerAId: { in: ghostIds } }, { playerBId: { in: ghostIds } }],
      },
      select: { playerAId: true, playerBId: true },
    });
    for (const m of prev) { prevPlayedSet.add(m.playerAId); prevPlayedSet.add(m.playerBId); }
  }

  const ghosts: InactiveRow[] = baseRows
    .map((r) => ({ ...r, playedPrevSeason: prevPlayedSet.has(r.playerId) }))
    .sort((a, b) => (a.lastPostMs ?? 0) - (b.lastPostMs ?? 0));

  return { hasSeason: true, scan, ghosts, activeTotal };
}
