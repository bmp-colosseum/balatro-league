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
  divisions: StandingsDivisionSummary[];
}

export interface StandingsPageData {
  season: { id: string; name: string } | null;
  tiers: StandingsTierSummary[];
  minTierPosition: number;
  maxTierPosition: number;
  // Map of playerId → ranked MMR for the BMP column. Empty when the
  // viewer has the toggle off — no DB roundtrip wasted on hidden data.
  mmrByPlayerId: Map<string, number>;
}

export async function loadStandingsPageData(opts: { showBmpMmr: boolean }): Promise<StandingsPageData> {
  const season = await prisma.season.findFirst({
    where: { isActive: true, visibility: "PUBLIC" },
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
          divisions: {
            orderBy: { groupNumber: "asc" },
            select: {
              id: true,
              name: true,
              groupNumber: true,
              members: { select: { playerId: true, status: true } },
              // _count is a single SQL count(), cheap.
              _count: { select: { pairings: { where: { status: "CONFIRMED" } } } },
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
  const allShootouts = allDivIds.length === 0 ? [] : await prisma.shootout.findMany({
    where: { divisionId: { in: allDivIds } },
    orderBy: { recordedAt: "desc" },
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
    const winnerName = playerNameById.get(s.winnerId);
    const loserId = s.winnerId === s.playerAId ? s.playerBId : s.playerAId;
    const loserName = playerNameById.get(loserId);
    if (!winnerName || !loserName) continue; // orphan — hide rather than crash
    const arr = shootoutsByDivisionId.get(s.divisionId) ?? [];
    arr.push({ id: s.id, winnerName, loserName, recordedAt: s.recordedAt });
    shootoutsByDivisionId.set(s.divisionId, arr);
  }

  // BMP MMR column is opt-in. Skip the query entirely when hidden.
  let mmrByPlayerId = new Map<string, number>();
  if (opts.showBmpMmr) {
    const allPlayerIds = season.tiers.flatMap((t) =>
      t.divisions.flatMap((d) => d.members.map((m) => m.playerId)),
    );
    if (allPlayerIds.length > 0) {
      const snapshots = await prisma.playerMmrSnapshot.findMany({
        where: { playerId: { in: allPlayerIds } },
        orderBy: { capturedAt: "desc" },
        distinct: ["playerId"],
        select: { playerId: true, rankedMmr: true },
      });
      mmrByPlayerId = new Map(
        snapshots
          .filter((s) => s.playerId && s.rankedMmr != null)
          .map((s) => [s.playerId!, s.rankedMmr!] as const),
      );
    }
  }

  const tiers: StandingsTierSummary[] = season.tiers.map((t) => ({
    id: t.id,
    name: t.name,
    position: t.position,
    divisions: t.divisions.map((d): StandingsDivisionSummary => ({
      id: d.id,
      name: d.name,
      groupNumber: d.groupNumber,
      activeMemberIds: d.members.filter((m) => m.status === "ACTIVE").map((m) => m.playerId),
      droppedMemberIds: d.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
      playedMatches: d._count.pairings,
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
  };
}
