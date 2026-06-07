// Loader for the /standings page. Returns:
//   - Active public season with tiers and divisions (lightweight: id +
//     name + position + groupNumber + active/dropped member ids +
//     confirmed pairing counts for the "X/Y matches" pill)
//   - Cached standings rows for every division at once
//   - BMP MMR snapshots for visible players (opt-in via cookie; skipped
//     when the viewer has the toggle off)
//
// computeStandings is NOT called here — the cache is authoritative for
// the standings rows. loadDivisionStandings transparently fills cold-cache
// divisions, so the first viewer pays the compute cost once.

import { prisma } from "@/lib/prisma";
import { loadDivisionStandings } from "@/lib/standings-cache";
import { formatSeasonLabel } from "@/lib/format-season";

export type StandingsRowsForDivision = Awaited<ReturnType<typeof loadDivisionStandings>>;

// Shootout result surfaced inline on the standings page so readers can
// see at-a-glance who broke which tie without clicking through to the
// division detail. Names are resolved at load time so the page render
// stays dependency-light.
export interface StandingsShootout {
  id: string;
  winnerName: string;
  loserName: string;
  recordedAt: Date;
}

export interface StandingsDivisionSummary {
  id: string;
  name: string;
  groupNumber: number;
  activeMemberIds: string[];
  droppedMemberIds: string[];
  playedMatches: number;
  rows: StandingsRowsForDivision;
  shootouts: StandingsShootout[];
}

export interface StandingsTierSummary {
  id: string;
  name: string;
  position: number;
  // How many top finishers promote / bottom finishers relegate from
  // this tier. Used by the UI to render the right number of ↑/↓
  // markers on the standings table.
  promoteRelegateCount: number;
  divisions: StandingsDivisionSummary[];
}

export interface StandingsMmrEntry {
  mmr: number;
  // The BMP-season tag this MMR came from (e.g. "season6"). Null for
  // ad-hoc captures that weren't tied to a specific season. The UI
  // annotates the cell when this isn't the current BMP season so
  // readers know they're looking at stale-but-still-useful data.
  bmpSeason: string | null;
}

export interface StandingsPageData {
  season: { id: string; name: string } | null;
  tiers: StandingsTierSummary[];
  minTierPosition: number;
  maxTierPosition: number;
  // Map of playerId → BMP MMR for the standings column. Empty when the
  // viewer has the toggle off — no DB roundtrip wasted on hidden data.
  mmrByPlayerId: Map<string, StandingsMmrEntry>;
  // What the bot currently believes is the active BMP season tag (e.g.
  // "season6"). Auto-detected from balatromp.com daily. Null when not
  // detected yet — UI falls back to never annotating in that case.
  bmpCurrentSeason: string | null;
}

export async function loadStandingsPageData(opts: { showBmpMmr: boolean }): Promise<StandingsPageData> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: {
      id: true,
      number: true,
      subtitle: true,
      tiers: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          name: true,
          position: true,
          promoteRelegateCount: true,
          divisions: {
            orderBy: { groupNumber: "asc" },
            select: {
              id: true,
              name: true,
              groupNumber: true,
              members: { select: { playerId: true, status: true } },
              // _count is a single SQL count(), cheap.
              _count: { select: { matches: { where: { status: "CONFIRMED", format: "LEAGUE_BO2" } } } },
            },
          },
        },
      },
    },
  });

  if (!season) {
    return {
      season: null,
      tiers: [],
      minTierPosition: 0,
      maxTierPosition: 0,
      mmrByPlayerId: new Map(),
      bmpCurrentSeason: null,
    };
  }

  const tierPositions = season.tiers.map((t) => t.position);
  const minTierPosition = tierPositions.length > 0 ? Math.min(...tierPositions) : 0;
  const maxTierPosition = tierPositions.length > 0 ? Math.max(...tierPositions) : 0;

  // Load cached standings rows for every division in parallel.
  const allDivIds = season.tiers.flatMap((t) => t.divisions.map((d) => d.id));
  const standingsByDivisionId = new Map<string, StandingsRowsForDivision>();
  const results = await Promise.all(
    allDivIds.map(async (id) => [id, await loadDivisionStandings(id)] as const),
  );
  for (const [id, rows] of results) standingsByDivisionId.set(id, rows);

  // All shootouts across this season's divisions in one round-trip.
  // Shootout has no Player relation in the schema, so we batch the
  // player-name lookup separately and stitch them together below.
  const allShootouts = allDivIds.length === 0 ? [] : await prisma.match.findMany({
    where: { divisionId: { in: allDivIds }, format: "SHOOTOUT_BO1" },
    orderBy: { confirmedAt: "desc" },
  });
  const shootoutPlayerIds = new Set<string>();
  for (const s of allShootouts) {
    shootoutPlayerIds.add(s.playerAId);
    shootoutPlayerIds.add(s.playerBId);
  }
  const shootoutPlayers = shootoutPlayerIds.size === 0 ? [] : await prisma.player.findMany({
    where: { id: { in: [...shootoutPlayerIds] } },
    select: { id: true, displayName: true },
  });
  const playerNameById = new Map(shootoutPlayers.map((p) => [p.id, p.displayName]));
  const shootoutsByDivisionId = new Map<string, StandingsShootout[]>();
  for (const s of allShootouts) {
    if (!s.winnerId) continue; // shootout with no recorded winner — skip
    const winnerName = playerNameById.get(s.winnerId);
    const loserId = s.winnerId === s.playerAId ? s.playerBId : s.playerAId;
    const loserName = playerNameById.get(loserId);
    if (!winnerName || !loserName) continue; // orphan — hide rather than crash
    const arr = shootoutsByDivisionId.get(s.divisionId) ?? [];
    arr.push({ id: s.id, winnerName, loserName, recordedAt: s.confirmedAt ?? s.createdAt });
    shootoutsByDivisionId.set(s.divisionId, arr);
  }

  // BMP MMR column is opt-in. Skip the query entirely when hidden.
  //
  // Picking strategy mirrors loadBuildSeasonPage:
  //   1. Filter to snapshots that ACTUALLY have a ranked MMR — otherwise
  //      a recent failed/empty capture would shadow a valid earlier one
  //      (distinct on playerId picks whatever the most recent row was,
  //      including the null one).
  //   2. Within remaining snapshots per player, prefer the highest
  //      bmpSeason number (so current BMP season wins over previous),
  //      then most recent capturedAt as the tiebreaker. A player who
  //      skipped the current BMP season but played last one still gets
  //      their last-season MMR shown.
  // Pull the current BMP season tag once so the UI knows which MMRs to
  // annotate as "stale". Null = not yet detected; UI falls back to
  // showing every cell without annotation.
  const bmpCurrentSeasonRow = await prisma.leagueConfig.findUnique({
    where: { key: "bmp_current_season" },
    select: { value: true },
  });
  const bmpCurrentSeason = bmpCurrentSeasonRow?.value ?? null;

  const mmrByPlayerId = new Map<string, StandingsMmrEntry>();
  if (opts.showBmpMmr) {
    const allPlayerIds = season.tiers.flatMap((t) =>
      t.divisions.flatMap((d) => d.members.map((m) => m.playerId)),
    );
    if (allPlayerIds.length > 0) {
      const snapshots = await prisma.playerMmrSnapshot.findMany({
        where: { playerId: { in: allPlayerIds }, rankedMmr: { not: null } },
        orderBy: { capturedAt: "desc" },
        select: { playerId: true, bmpSeason: true, rankedMmr: true, capturedAt: true },
      });
      // Group per playerId, then pick the preferred snapshot by
      // (bmpSeason number desc, capturedAt desc). Doing this in JS
      // rather than at the DB layer because Prisma can't sort + distinct
      // by a derived field (the numeric suffix of bmpSeason).
      const seasonNum = (tag: string | null): number => {
        if (!tag) return -Infinity;
        const m = /^season(\d+)$/.exec(tag);
        return m ? parseInt(m[1]!, 10) : -Infinity;
      };
      const byPlayer = new Map<string, typeof snapshots>();
      for (const s of snapshots) {
        if (!s.playerId) continue;
        const arr = byPlayer.get(s.playerId) ?? [];
        arr.push(s);
        byPlayer.set(s.playerId, arr);
      }
      for (const [pid, arr] of byPlayer) {
        arr.sort((a, b) => {
          const na = seasonNum(a.bmpSeason);
          const nb = seasonNum(b.bmpSeason);
          if (na !== nb) return nb - na;
          return b.capturedAt.getTime() - a.capturedAt.getTime();
        });
        const best = arr[0];
        if (best?.rankedMmr != null) {
          mmrByPlayerId.set(pid, { mmr: best.rankedMmr, bmpSeason: best.bmpSeason });
        }
      }
    }
  }

  const tiers: StandingsTierSummary[] = season.tiers.map((t) => ({
    id: t.id,
    name: t.name,
    position: t.position,
    promoteRelegateCount: t.promoteRelegateCount,
    divisions: t.divisions.map((d): StandingsDivisionSummary => ({
      id: d.id,
      name: d.name,
      groupNumber: d.groupNumber,
      activeMemberIds: d.members.filter((m) => m.status === "ACTIVE").map((m) => m.playerId),
      droppedMemberIds: d.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
      playedMatches: d._count.matches,
      rows: standingsByDivisionId.get(d.id) ?? [],
      shootouts: shootoutsByDivisionId.get(d.id) ?? [],
    })),
  }));

  return {
    season: { id: season.id, name: formatSeasonLabel(season) },
    tiers,
    minTierPosition,
    maxTierPosition,
    mmrByPlayerId,
    bmpCurrentSeason,
  };
}
