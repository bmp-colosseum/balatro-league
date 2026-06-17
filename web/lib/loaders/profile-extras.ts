// Supplementary loaders for the /profile/[id] page — the main history
// data comes from loadPlayerHistory in @/lib/profile. This file covers
// the auxiliary queries: viewer identity, BMP MMR snapshots, and the
// admin-only record-set context.
//
// Single bundle so the page can call one function instead of orchestrating
// several conditional Prisma calls inline.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

export interface ProfileViewer {
  discordId: string | null;
  playerId: string | null;
  isOwnProfile: boolean;
  isAdmin: boolean;
}

export interface ProfileBmpSnapshot {
  id: string;
  bmpSeason: string | null;
  rankedMmr: number | null;
  rankedTier: string | null;
  capturedAt: Date;
  leaderboardRank: number | null;
  wins: number | null;
  losses: number | null;
  totalGames: number | null;
  winRatePct: number | null;
  peakMmr: number | null;
  peakStreak: number | null;
}

export interface AdminRecordContext {
  divisionId: string;
  divisionName: string;
  // Active members of the player's division — for name resolution in the
  // consolidated MatchActionsPanel.
  members: Array<{ playerId: string; displayName: string }>;
  // This player's matchups, split by state, scoped so the panel only offers
  // matches involving them. unplayed = "resolve a match"; played = "fix".
  unplayed: Array<{ p1Id: string; p2Id: string }>;
  played: Array<{ p1Id: string; p2Id: string; summary: string }>;
}

// Active-season division context for the profile OWNER — drives the
// "report a match" dropdown that lets them log results without
// leaving their profile. Only populated when the viewer IS the profile
// owner AND they have an ACTIVE membership in a PUBLIC season.
export interface OwnActiveDivision {
  divisionId: string;
  divisionName: string;
  seasonId: string;
  seasonName: string;
  reportableOpponents: Array<{ playerId: string; displayName: string }>;
}

export interface ProfileExtras {
  viewer: ProfileViewer;
  bmpSeasonSnapshots: ProfileBmpSnapshot[];
  fallbackSnapshot: ProfileBmpSnapshot | null;
  adminCtx: AdminRecordContext | null;
  ownActiveDivision: OwnActiveDivision | null;
}

export async function loadProfileExtras(opts: {
  profilePlayerId: string;
  profileDiscordId: string;
  viewerDiscordId: string | null;
  isViewerAdmin: boolean;
  showBmpMmr: boolean;
}): Promise<ProfileExtras> {
  const {
    profilePlayerId,
    profileDiscordId,
    viewerDiscordId,
    isViewerAdmin,
    showBmpMmr,
  } = opts;

  // Viewer identity — needed to compute isOwnProfile for dispute UI.
  const viewerPlayer = viewerDiscordId
    ? await prisma.player.findUnique({
        where: { discordId: viewerDiscordId },
        select: { id: true },
      })
    : null;

  // All independent lookups in parallel. Each is a single small query.
  const [bmpSeasonSnapshots, adminCtx] = await Promise.all([
    showBmpMmr
      ? prisma.playerMmrSnapshot.findMany({
          where: {
            OR: [{ playerId: profilePlayerId }, { discordId: profileDiscordId }],
            rankedMmr: { not: null },
            bmpSeason: { not: null },
          },
          orderBy: [{ bmpSeason: "desc" }, { capturedAt: "desc" }],
          distinct: ["bmpSeason"],
          select: {
            id: true,
            bmpSeason: true,
            rankedMmr: true,
            rankedTier: true,
            capturedAt: true,
            leaderboardRank: true,
            wins: true,
            losses: true,
            totalGames: true,
            winRatePct: true,
            peakMmr: true,
            peakStreak: true,
          },
        })
      : Promise.resolve([] as ProfileBmpSnapshot[]),
    isViewerAdmin ? loadAdminRecordContext(profilePlayerId) : Promise.resolve(null),
  ]);

  // Lexicographic 'seasonN' sort puts season9 above season10. Fix by
  // parsing the number — distinct + orderBy doesn't fully control final
  // order in Postgres.
  const sortedSnapshots = [...bmpSeasonSnapshots].sort((a, b) => {
    const aN = parseInt(a.bmpSeason?.replace(/^season/, "") ?? "0", 10);
    const bN = parseInt(b.bmpSeason?.replace(/^season/, "") ?? "0", 10);
    return bN - aN;
  });

  // Fallback for players with no labeled bmpSeason snapshots (legacy).
  const fallbackSnapshot =
    showBmpMmr && sortedSnapshots.length === 0
      ? await prisma.playerMmrSnapshot.findFirst({
          where: {
            OR: [{ playerId: profilePlayerId }, { discordId: profileDiscordId }],
            rankedMmr: { not: null },
          },
          orderBy: { capturedAt: "desc" },
          select: {
            id: true,
            bmpSeason: true,
            rankedMmr: true,
            rankedTier: true,
            capturedAt: true,
            leaderboardRank: true,
            wins: true,
            losses: true,
            totalGames: true,
            winRatePct: true,
            peakMmr: true,
            peakStreak: true,
          },
        })
      : null;

  const isOwnProfile = !!viewerPlayer && viewerPlayer.id === profilePlayerId;
  // Only compute the "report a match" context when the viewer IS the
  // profile owner — saves a roundtrip for every random viewer.
  const ownActiveDivision = isOwnProfile
    ? await loadOwnActiveDivision(profilePlayerId)
    : null;

  return {
    viewer: {
      discordId: viewerDiscordId,
      playerId: viewerPlayer?.id ?? null,
      isOwnProfile,
      isAdmin: isViewerAdmin,
    },
    bmpSeasonSnapshots: sortedSnapshots,
    fallbackSnapshot,
    adminCtx,
    ownActiveDivision,
  };
}

// Same shape as /me's loadActiveDivisionContext but returns the
// OwnActiveDivision interface so the profile page can render the
// 'report a match' dropdown.
async function loadOwnActiveDivision(playerId: string): Promise<OwnActiveDivision | null> {
  const membership = await prisma.divisionMember.findFirst({
    where: {
      playerId,
      status: "ACTIVE",
      division: { season: { isActive: true } },
    },
    select: {
      assignmentGroup: true,
      division: {
        select: {
          id: true,
          name: true,
          seasonId: true,
          season: { select: { number: true, subtitle: true } },
          members: {
            where: { status: "ACTIVE" },
            select: { playerId: true, assignmentGroup: true, player: { select: { id: true, displayName: true } } },
          },
        },
      },
    },
  });
  if (!membership) return null;
  const div = membership.division;
  const myPairings = await prisma.match.findMany({
    where: {
      divisionId: div.id,
      status: "CONFIRMED",
      format: "LEAGUE_BO2",
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: { playerAId: true, playerBId: true },
  });
  const played = new Set<string>();
  for (const p of myPairings) {
    played.add(p.playerAId === playerId ? p.playerBId : p.playerAId);
  }
  // Scope to your sub-group (null = legacy whole-division round-robin).
  const myGroup = membership.assignmentGroup;
  const reportableOpponents = div.members
    .filter(
      (m) =>
        m.playerId !== playerId &&
        !played.has(m.playerId) &&
        (myGroup == null || m.assignmentGroup === myGroup),
    )
    .map((m) => ({ playerId: m.playerId, displayName: m.player.displayName }));
  return {
    divisionId: div.id,
    divisionName: div.name,
    seasonId: div.seasonId,
    seasonName: formatSeasonLabel(div.season),
    reportableOpponents,
  };
}

async function loadAdminRecordContext(playerId: string): Promise<AdminRecordContext | null> {
  const membership = await prisma.divisionMember.findFirst({
    where: {
      playerId,
      status: "ACTIVE",
      division: { season: { isActive: true } },
    },
    include: {
      division: {
        include: {
          members: { where: { status: "ACTIVE" }, include: { player: true } },
          matches: {
            where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
      },
    },
  });
  if (!membership) return null;
  const div = membership.division;

  // This player's confirmed matches → "fix" pairs with a score/void summary.
  const myMatches = div.matches.filter((p) => p.playerAId === playerId || p.playerBId === playerId);
  const playedOpponents = new Set(
    myMatches.map((p) => (p.playerAId === playerId ? p.playerBId : p.playerAId)),
  );
  const played = myMatches.map((p) => ({
    p1Id: p.playerAId,
    p2Id: p.playerBId,
    summary: p.gamesWonA === 0 && p.gamesWonB === 0 ? "0-0 void" : `${p.gamesWonA}-${p.gamesWonB}`,
  }));
  // Unplayed matchups for this player → "resolve" pairs (this player first).
  const unplayed = div.members
    .filter((m) => m.playerId !== playerId && !playedOpponents.has(m.playerId))
    .map((m) => ({ p1Id: playerId, p2Id: m.playerId }));
  const members = div.members.map((m) => ({ playerId: m.playerId, displayName: m.player.displayName }));
  return { divisionId: div.id, divisionName: div.name, members, unplayed, played };
}
