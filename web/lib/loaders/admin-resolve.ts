// Data for the consolidated end-of-season "resolve everything" surface
// (/admin/resolve). Unlike /admin/results (a free-form per-division picker
// that lists every un-played member pair), this only surfaces REAL scheduled
// matches that are stuck: LEAGUE_BO2 Match rows still PENDING or DISPUTED.
// With the 4-opponent graph schedule most member pairs were never meant to
// play, so "every pair without a match" would list hundreds of bogus rows —
// this loader deliberately does not compute that.

import "server-only";

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

export interface UnresolvedMember {
  playerId: string;
  displayName: string;
}
export interface UnresolvedPair {
  p1Id: string;
  p2Id: string;
  status: string;
}
export interface UnresolvedDivision {
  divisionId: string;
  divisionName: string;
  tierName: string;
  members: UnresolvedMember[];
  pairs: UnresolvedPair[];
}
export interface UnresolvedMatchesData {
  hasActiveSeason: boolean;
  seasonLabel: string | null;
  totalUnresolved: number;
  divisions: UnresolvedDivision[];
}

export async function loadUnresolvedMatches(): Promise<UnresolvedMatchesData> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, number: true, subtitle: true },
  });
  if (!season) {
    return { hasActiveSeason: false, seasonLabel: null, totalUnresolved: 0, divisions: [] };
  }

  const divisionsRaw = await prisma.division.findMany({
    where: { seasonId: season.id },
    select: {
      id: true,
      name: true,
      tier: { select: { name: true, position: true } },
      members: {
        where: { status: "ACTIVE" },
        select: { playerId: true, player: { select: { displayName: true } } },
        orderBy: { player: { displayName: "asc" } },
      },
      matches: {
        where: { format: "LEAGUE_BO2", status: { in: ["PENDING", "DISPUTED"] } },
        select: { playerAId: true, playerBId: true, status: true },
      },
    },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
  });

  const divisions: UnresolvedDivision[] = divisionsRaw
    .filter((d) => d.matches.length > 0)
    .map((d) => ({
      divisionId: d.id,
      divisionName: d.name,
      tierName: d.tier.name,
      members: d.members.map((m) => ({ playerId: m.playerId, displayName: m.player.displayName })),
      pairs: d.matches.map((m) => ({ p1Id: m.playerAId, p2Id: m.playerBId, status: String(m.status) })),
    }));

  const totalUnresolved = divisions.reduce((sum, d) => sum + d.pairs.length, 0);

  return {
    hasActiveSeason: true,
    seasonLabel: formatSeasonLabel(season),
    totalUnresolved,
    divisions,
  };
}
