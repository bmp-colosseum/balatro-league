// Supplementary loaders for the /profile/[id] page — the main history
// data comes from loadPlayerHistory in @/lib/profile. This file covers
// the auxiliary queries: viewer identity, easter-egg vote tallies, BMP
// MMR snapshots, and the admin-only record-set context.
//
// Single bundle so the page can call one function instead of orchestrating
// five conditional Prisma calls inline.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

export interface ProfileViewer {
  discordId: string | null;
  playerId: string | null;
  isOwnProfile: boolean;
  isAdmin: boolean;
}

export interface SanjiVoteData {
  isSanji: boolean;
  voterDiscordId: string | null;
  yesVotes: number;
  noVotes: number;
  myVote: "yes" | "no" | null;
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
  opponents: Array<{ playerId: string; displayName: string }>;
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
  sanji: SanjiVoteData;
  bmpSeasonSnapshots: ProfileBmpSnapshot[];
  fallbackSnapshot: ProfileBmpSnapshot | null;
  adminCtx: AdminRecordContext | null;
  ownActiveDivision: OwnActiveDivision | null;
}

export async function loadProfileExtras(opts: {
  profilePlayerId: string;
  profileDiscordId: string;
  profileDisplayName: string;
  viewerDiscordId: string | null;
  isViewerAdmin: boolean;
  showBmpMmr: boolean;
}): Promise<ProfileExtras> {
  const {
    profilePlayerId,
    profileDiscordId,
    profileDisplayName,
    viewerDiscordId,
    isViewerAdmin,
    showBmpMmr,
  } = opts;

  const isSanji = profileDisplayName.toLowerCase().includes("sanji");

  // Viewer identity — needed to compute isOwnProfile for dispute UI.
  const viewerPlayer = viewerDiscordId
    ? await prisma.player.findUnique({
        where: { discordId: viewerDiscordId },
        select: { id: true },
      })
    : null;

  // All independent lookups in parallel. Each is a single small query.
  const [voteCounts, myVoteRow, bmpSeasonSnapshots, adminCtx] = await Promise.all([
    isSanji
      ? prisma.easterEggVote.groupBy({
          by: ["side"],
          where: { targetKey: "sanji" },
          _count: { side: true },
        })
      : Promise.resolve([] as Array<{ side: string; _count: { side: number } }>),
    isSanji && viewerDiscordId
      ? prisma.easterEggVote.findUnique({
          where: { targetKey_voterDiscordId: { targetKey: "sanji", voterDiscordId: viewerDiscordId } },
        })
      : Promise.resolve(null),
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

  const yesVotes = voteCounts.find((c) => c.side === "yes")?._count.side ?? 0;
  const noVotes = voteCounts.find((c) => c.side === "no")?._count.side ?? 0;
  const myVote: "yes" | "no" | null =
    myVoteRow?.side === "yes" || myVoteRow?.side === "no" ? myVoteRow.side : null;

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
    sanji: {
      isSanji,
      voterDiscordId: viewerDiscordId,
      yesVotes,
      noVotes,
      myVote,
    },
    bmpSeasonSnapshots: sortedSnapshots,
    fallbackSnapshot,
    adminCtx,
    ownActiveDivision,
  };
}

// Same shape as /me's loadActiveDivisionContext but returns the
// OwnActiveDivision interface so the profile page can render the
// 'report a match' dropdown. Only PUBLIC active seasons — INTERNAL
// test seasons don't surface to player-facing UI.
async function loadOwnActiveDivision(playerId: string): Promise<OwnActiveDivision | null> {
  const membership = await prisma.divisionMember.findFirst({
    where: {
      playerId,
      status: "ACTIVE",
      division: { season: { isActive: true, visibility: "PUBLIC" } },
    },
    select: {
      division: {
        select: {
          id: true,
          name: true,
          seasonId: true,
          season: { select: { number: true, subtitle: true } },
          members: {
            where: { status: "ACTIVE" },
            select: { playerId: true, player: { select: { id: true, displayName: true } } },
          },
        },
      },
    },
  });
  if (!membership) return null;
  const div = membership.division;
  const myPairings = await prisma.pairing.findMany({
    where: {
      divisionId: div.id,
      status: "CONFIRMED",
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: { playerAId: true, playerBId: true },
  });
  const played = new Set<string>();
  for (const p of myPairings) {
    played.add(p.playerAId === playerId ? p.playerBId : p.playerAId);
  }
  const reportableOpponents = div.members
    .filter((m) => m.playerId !== playerId && !played.has(m.playerId))
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
          pairings: { where: { status: "CONFIRMED" }, select: { playerAId: true, playerBId: true } },
        },
      },
    },
  });
  if (!membership) return null;
  const div = membership.division;
  const played = new Set(
    div.pairings
      .filter((p) => p.playerAId === playerId || p.playerBId === playerId)
      .map((p) => (p.playerAId === playerId ? p.playerBId : p.playerAId)),
  );
  const opponents = div.members
    .filter((m) => m.playerId !== playerId && !played.has(m.playerId))
    .map((m) => ({ playerId: m.playerId, displayName: m.player.displayName }));
  return { divisionId: div.id, divisionName: div.name, opponents };
}
