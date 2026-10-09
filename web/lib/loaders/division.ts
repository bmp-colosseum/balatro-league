// Loader for the public /divisions/[id] page. Returns:
//   - Division header (name, season, tier)
//   - Cached standings rows + which players are dropped
//   - Recent confirmed pairings (top 30, newest first)
//   - Unplayed matchups across ACTIVE members
//
// Uses the DivisionStandings cache for the standings rows rather than
// recomputing in-process. Pairings include the playerA + playerB
// display names so the rendering doesn't need a second hydration pass.

import { prisma } from "@/lib/prisma";
import { loadDivisionStandings, loadDivisionScoringBadge, loadDivisionUncounted } from "@/lib/standings-cache";
import { formatSeasonLabel } from "@/lib/format-season";
import { computeUnplayedPairs, pairKey } from "@/lib/unplayed-pairs";
import { normalizeTiebreak, type ScoringBadge } from "@/lib/standings-mode";
import type { UncountedEntry } from "@/lib/uncounted-core";
import { getPlacementRules } from "@/lib/placement-rules";
import { scheduleDegree } from "@/lib/schedule";

export interface DivisionStandingRow {
  player: { id: string; displayName: string; discordId: string; username: string | null };
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  played: number;
  tiedWithPrev?: boolean;
  dropped: boolean;
  // Set only under a best-N scoring mode -- see StandingRow.counted/of.
  counted?: number;
  of?: number;
  // Set when this row carries a net-lives value -- either because the
  // season's tiebreak is "lives" (every row), or it's "chain" and this row
  // is part of a tie group (see attachLivesToTiedRows). See
  // StandingRow.netLives/livesGamesMissing.
  netLives?: number;
  livesGamesMissing?: number;
  // See StandingRow.tiebreakNote -- plain-English audit of which step
  // decided this row's tie, present under the same conditions as netLives.
  tiebreakNote?: string;
}

export interface DivisionRecentPairing {
  id: string;
  date: Date | null;
  playerA: { id: string; displayName: string; discordId: string; username: string | null };
  playerB: { id: string; displayName: string; discordId: string; username: string | null };
  gamesWonA: number;
  gamesWonB: number;
  forfeit: boolean;
}

// One row per shootout in this division. Surfaced as its own list on
// the public page so readers can see how a tied pair was broken
// without having to dig through standings logic.
export interface DivisionShootout {
  id: string;
  recordedAt: Date;
  winner: { id: string; displayName: string; discordId: string; username: string | null };
  loser: { id: string; displayName: string; discordId: string; username: string | null };
  notes: string | null;
  selfReported: boolean;
}

export interface DivisionUnplayed {
  a: { id: string; displayName: string; discordId: string; username: string | null };
  b: { id: string; displayName: string; discordId: string; username: string | null };
}

export interface DivisionPageData {
  division: {
    id: string;
    name: string;
    seasonId: string;
    seasonName: string;
    tierName: string;
    tierPosition: number;
    activeCount: number;
    confirmedPairingCount: number;
    // Ladder-wide promote/relegate counts + schedule format, for the v2
    // "Card Table" header strip's "N up / N down / schedule" meta line --
    // same arithmetic as loadStandingsPageData (lib/loaders/standings.ts),
    // computed locally below since this single-division page doesn't load
    // the whole season's standings. 0 at the very top/bottom of the ladder.
    promote: number;
    relegate: number;
    // "round-robin" or "<N> opponents" -- see lib/schedule.ts' scheduleDegree.
    scheduleFormat: string;
  };
  standings: DivisionStandingRow[];
  // Set only when this season's scoringMode is a best-n mode AND this
  // division currently has at least one unreplaced dropout -- the "counts
  // best N of K-1" badge. Null otherwise (standard scoring, or a best-n
  // season with nothing for it to change here right now).
  scoringBadge: ScoringBadge | null;
  // Which of this division's matches are currently set aside under a
  // best-N scoring mode -- see web/lib/uncounted-core.ts. Always present
  // (empty when nothing is set aside) so callers can pass it straight to
  // uncountedTag without a null check.
  uncounted: UncountedEntry[];
  recentPairings: DivisionRecentPairing[];
  shootouts: DivisionShootout[];
  unplayed: DivisionUnplayed[];
  // True when this season's tiebreak is "lives" (ties ARE broken by net
  // lives) vs the default "chain" (net lives shown for tied players only as
  // informational context -- see attachLivesToTiedRows). Drives the Lives
  // column's footnote wording on DivisionStandingsTable.
  livesBreaksTies: boolean;
}

const RECENT_PAIRINGS_LIMIT = 30;

export async function loadDivisionPageData(divisionId: string): Promise<DivisionPageData | null> {
  const division = await prisma.division.findFirst({
    where: { id: divisionId },
    select: {
      id: true,
      name: true,
      seasonId: true,
      tier: { select: { name: true, position: true } },
      season: { select: { number: true, subtitle: true, scheduleLocked: true, tiebreak: true } },
      members: {
        select: {
          playerId: true,
          status: true,
          player: { select: { id: true, displayName: true, discordId: true, username: true } },
        },
        orderBy: { joinedAt: "asc" },
      },
    },
  });
  if (!division) return null;

  const droppedIds = new Set(
    division.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
  );
  const activeMembers = division.members.filter((m) => m.status === "ACTIVE");

  // Ladder-wide promote/relegate counts + schedule format (tier position,
  // then group number -- same ordering as loadStandingsPageData). The top
  // division overall never promotes; the bottom never relegates.
  const rules = await getPlacementRules();
  const ladderSeason = await prisma.season.findUnique({
    where: { id: division.seasonId },
    select: {
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        select: {
          id: true,
          opponentsPerPlayer: true,
          promoteCount: true,
          relegateCount: true,
          members: { where: { status: "ACTIVE" }, select: { id: true } },
        },
      },
    },
  });
  const ladder = ladderSeason?.divisions ?? [];
  const ladderIndex = ladder.findIndex((d) => d.id === division.id);
  const thisLadderDiv = ladderIndex >= 0 ? ladder[ladderIndex]! : null;
  const ladderActiveSize = thisLadderDiv?.members.length ?? activeMembers.length;
  const promote =
    thisLadderDiv && ladderIndex > 0
      ? Math.min(Math.max(0, thisLadderDiv.promoteCount), ladderActiveSize)
      : 0;
  const relegate =
    thisLadderDiv && ladderIndex < ladder.length - 1
      ? Math.min(Math.max(0, thisLadderDiv.relegateCount), ladderActiveSize)
      : 0;
  const scheduleDeg = scheduleDegree(
    thisLadderDiv?.opponentsPerPlayer,
    rules.defaultOpponentsPerPlayer,
    ladderActiveSize,
  );
  const scheduleFormat = scheduleDeg >= ladderActiveSize - 1 ? "round-robin" : `${scheduleDeg} opponents`;

  // Cached standings — same source as /standings, no recompute. Read the
  // badge AFTER (not before) loadDivisionStandings, which warms the cache
  // on a cold miss -- loadDivisionScoringBadge itself never computes.
  const standingsRows = await loadDivisionStandings(divisionId);
  const scoringBadge = await loadDivisionScoringBadge(divisionId);
  const uncounted = await loadDivisionUncounted(divisionId);
  const standings: DivisionStandingRow[] = standingsRows.map((r) => ({
    player: { id: r.player.id, displayName: r.player.displayName, discordId: r.player.discordId, username: r.player.username },
    points: r.points,
    wins: r.wins,
    draws: r.draws,
    losses: r.losses,
    gamesWon: r.gamesWon,
    gamesLost: r.gamesLost,
    played: r.played,
    tiedWithPrev: r.tiedWithPrev,
    dropped: droppedIds.has(r.player.id),
    counted: r.counted,
    of: r.of,
    netLives: r.netLives,
    livesGamesMissing: r.livesGamesMissing,
    tiebreakNote: r.tiebreakNote,
  }));

  const pairings = await prisma.match.findMany({
    where: { divisionId, status: "CONFIRMED", format: "LEAGUE_BO2" },
    select: {
      id: true,
      confirmedAt: true,
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
      forfeit: true,
      playerA: { select: { id: true, displayName: true, discordId: true, username: true } },
      playerB: { select: { id: true, displayName: true, discordId: true, username: true } },
    },
    orderBy: { confirmedAt: "desc" },
  });
  const recentPairings: DivisionRecentPairing[] = pairings
    .slice(0, RECENT_PAIRINGS_LIMIT)
    .map((p) => ({
      id: p.id,
      date: p.confirmedAt,
      playerA: p.playerA,
      playerB: p.playerB,
      gamesWonA: p.gamesWonA,
      gamesWonB: p.gamesWonB,
      forfeit: p.forfeit,
    }));

  // Unplayed matchups across ACTIVE members. With a locked schedule (graph or
  // pre-created round-robin) only the ASSIGNED pairs are real matchups; with no
  // locked schedule it's a full round-robin (every not-yet-played pair).
  const playedSet = new Set(pairings.map((p) => pairKey(p.playerAId, p.playerBId)));

  // season.scheduleLocked is only a fast-path; the authoritative signal is a
  // pre-created, never-played 0-0 PENDING match (see isScheduleLocked's own
  // doc comment). When the flag is already true we trust it and skip the DB
  // round trip entirely. When it's false we still need to rule out a stale
  // flag, but a cheap existence check (hits the @@index([divisionId, status,
  // confirmedAt]) prefix) answers that without pulling every match row in the
  // division — the full row fetch below only happens for divisions that
  // actually turn out to be locked, where we need it anyway to build the
  // assigned-pairs set.
  const scheduleLocked =
    division.season.scheduleLocked ||
    (await prisma.match.findFirst({
      where: { divisionId, format: "LEAGUE_BO2", status: "PENDING", gamesWonA: 0, gamesWonB: 0 },
      select: { id: true },
    })) !== null;

  const assignedSet = new Set<string>();
  if (scheduleLocked) {
    const scheduleMatches = await prisma.match.findMany({
      where: { divisionId, format: "LEAGUE_BO2" },
      select: { playerAId: true, playerBId: true },
    });
    for (const m of scheduleMatches) assignedSet.add(pairKey(m.playerAId, m.playerBId));
  }

  const unplayed: DivisionUnplayed[] = computeUnplayedPairs({
    activeMembers: activeMembers.map((m) => ({ id: m.player.id, data: m.player })),
    playedKeys: playedSet,
    scheduleLocked,
    assignedKeys: assignedSet,
  });

  // Shootouts — separate model from Pairing. We resolve the two players
  // through the active-member list (which is already loaded) so we
  // avoid an extra round trip per shootout.
  const memberById = new Map(division.members.map((m) => [m.playerId, m.player]));
  const rawShootouts = await prisma.match.findMany({
    where: { divisionId, format: "SHOOTOUT_BO1" },
    orderBy: { confirmedAt: "desc" },
  });
  const shootouts: DivisionShootout[] = rawShootouts.flatMap((s) => {
    const a = memberById.get(s.playerAId);
    const b = memberById.get(s.playerBId);
    if (!a || !b) return [];
    const winner = s.winnerId === a.id ? a : b;
    const loser = s.winnerId === a.id ? b : a;
    return [{
      id: s.id,
      recordedAt: s.confirmedAt ?? s.createdAt,
      winner,
      loser,
      notes: s.notes ?? null,
      selfReported: s.recordedBy === "self-report",
    }];
  });

  return {
    division: {
      id: division.id,
      name: division.name,
      seasonId: division.seasonId,
      seasonName: formatSeasonLabel(division.season),
      tierName: division.tier.name,
      tierPosition: division.tier.position,
      activeCount: activeMembers.length,
      confirmedPairingCount: pairings.length,
      promote,
      relegate,
      scheduleFormat,
    },
    standings,
    scoringBadge,
    uncounted,
    recentPairings,
    shootouts,
    unplayed,
    livesBreaksTies: normalizeTiebreak(division.season.tiebreak) === "lives",
  };
}
