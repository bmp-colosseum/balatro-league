// Admin-side loaders. Each function backs one /admin/* page; they're
// grouped in one file because individually they're small and they
// share a domain (season + division admin data).
//
// Conventions:
//   - All admin loaders assume requireAdmin() ran in the page
//   - Return shapes are page-specific; never expose raw Prisma types
//     to the caller (so the schema can evolve without touching pages)
//   - Cached standings come from loadDivisionStandings, not inline
//     computeStandings

import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { computeRatingDeltas, type DivisionForRating } from "@/lib/end-season";

const MOCK_PREFIXES = ["mock-", "sim-"];
function isMockId(id: string) {
  return MOCK_PREFIXES.some((p) => id.startsWith(p));
}

// ── /admin/disputes ──────────────────────────────────────────────────

export interface AdminDisputeRow {
  pairingId: string;
  divisionId: string;
  divisionName: string;
  tierName: string;
  playerA: { id: string; displayName: string };
  playerB: { id: string; displayName: string };
  gamesWonA: number;
  gamesWonB: number;
  disputedAt: Date | null;
  disputer: { id: string; displayName: string; discordId: string } | null;
  reporter: { id: string; displayName: string } | null;
  disputeProposedGamesWonA: number | null;
  disputeProposedGamesWonB: number | null;
  disputeReason: string | null;
  disputeThreadId: string | null;
}

export async function loadAdminDisputes(): Promise<AdminDisputeRow[]> {
  const rows = await prisma.pairing.findMany({
    where: { status: "DISPUTED", division: { season: { isActive: true } } },
    select: {
      id: true,
      divisionId: true,
      gamesWonA: true,
      gamesWonB: true,
      disputedAt: true,
      disputeProposedGamesWonA: true,
      disputeProposedGamesWonB: true,
      disputeReason: true,
      disputeThreadId: true,
      playerA: { select: { id: true, displayName: true } },
      playerB: { select: { id: true, displayName: true } },
      disputer: { select: { id: true, displayName: true, discordId: true } },
      reporter: { select: { id: true, displayName: true } },
      division: {
        select: {
          name: true,
          tier: { select: { name: true } },
        },
      },
    },
    orderBy: { disputedAt: "desc" },
  });
  return rows.map((r) => ({
    pairingId: r.id,
    divisionId: r.divisionId,
    divisionName: r.division.name,
    tierName: r.division.tier.name,
    playerA: r.playerA,
    playerB: r.playerB,
    gamesWonA: r.gamesWonA,
    gamesWonB: r.gamesWonB,
    disputedAt: r.disputedAt,
    disputer: r.disputer,
    reporter: r.reporter,
    disputeProposedGamesWonA: r.disputeProposedGamesWonA,
    disputeProposedGamesWonB: r.disputeProposedGamesWonB,
    disputeReason: r.disputeReason,
    disputeThreadId: r.disputeThreadId,
  }));
}

// ── /admin/divisions (index) ─────────────────────────────────────────

export interface AdminDivisionsTier {
  id: string;
  name: string;
  position: number;
  divisions: Array<{
    id: string;
    name: string;
    memberCount: number;
    targetSize: number;
    confirmedPairingCount: number;
    expectedPairingCount: number;
  }>;
}

export interface AdminDivisionsPageData {
  season: { id: string; name: string; targetGroupSize: number } | null;
  tiers: AdminDivisionsTier[];
}

function expectedPairings(memberCount: number): number {
  return memberCount < 2 ? 0 : (memberCount * (memberCount - 1)) / 2;
}

// ── /admin (dashboard) ───────────────────────────────────────────────

export interface AdminHomeStats {
  activeSeason: { id: string; name: string; divisionCount: number } | null;
  totalPlayers: number;
  fakePlayerCount: number;
  confirmedPairings: number;
  disputedPairings: number;
}

export async function loadAdminHomeStats(): Promise<AdminHomeStats> {
  const [activeSeason, totalPlayers, allDiscordIds, confirmed, disputed] = await Promise.all([
    prisma.season.findFirst({
      where: { isActive: true },
      select: { id: true, name: true, _count: { select: { divisions: true } } },
    }),
    prisma.player.count(),
    prisma.player.findMany({ select: { discordId: true } }),
    prisma.pairing.count({ where: { status: "CONFIRMED" } }),
    prisma.pairing.count({ where: { status: "DISPUTED" } }),
  ]);
  return {
    activeSeason: activeSeason
      ? { id: activeSeason.id, name: activeSeason.name, divisionCount: activeSeason._count.divisions }
      : null,
    totalPlayers,
    fakePlayerCount: allDiscordIds.filter((p) => isMockId(p.discordId)).length,
    confirmedPairings: confirmed,
    disputedPairings: disputed,
  };
}

// ── /admin/seasons/templates ─────────────────────────────────────────

export interface AdminTemplateRow {
  id: string;
  name: string;
  isLastUsed: boolean;
  updatedAt: Date;
  config: Array<{ name: string; divisionCount: number }>;
}

export async function loadAdminTemplates(): Promise<AdminTemplateRow[]> {
  const templates = await prisma.tierTemplate.findMany({
    orderBy: [{ isLastUsed: "desc" }, { name: "asc" }],
    select: { id: true, name: true, isLastUsed: true, updatedAt: true, config: true },
  });
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    isLastUsed: t.isLastUsed,
    updatedAt: t.updatedAt,
    config: parseTemplateConfig(t.config),
  }));
}

function parseTemplateConfig(json: string): Array<{ name: string; divisionCount: number }> {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => ({
      name: String(e?.name ?? ""),
      divisionCount: Number(e?.divisionCount) || 1,
    }));
  } catch {
    return [];
  }
}

// ── /admin/seasons/[id]/end ──────────────────────────────────────────

export interface EndSeasonDivisionRow {
  divisionId: string;
  divisionName: string;
  tierName: string;
  tierPosition: number;
  standings: ReturnType<typeof computeStandings>;
  members: Array<{ playerId: string; status: "ACTIVE" | "DROPPED"; currentRating: number | null }>;
}

export interface EndSeasonPreview {
  season: { id: string; name: string };
  unfinishedPairings: number;
  divisions: EndSeasonDivisionRow[];
  deltasByPlayer: Map<string, { playerId: string; oldRating: number | null; newRating: number; delta: number }>;
}

export async function loadEndSeasonPreview(seasonId: string): Promise<EndSeasonPreview | null> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: {
      tiers: { orderBy: { position: "asc" } },
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: {
          tier: true,
          members: { include: { player: true } },
          pairings: { where: { status: "CONFIRMED" } },
        },
      },
    },
  });
  if (!season) return null;

  const divisionsForRating: DivisionForRating[] = season.divisions.map((d) => {
    const players = d.members.map((m) => m.player);
    return {
      tierPosition: d.tier.position,
      members: d.members.map((m) => ({
        playerId: m.playerId,
        status: m.status,
        currentRating: m.player.rating,
      })),
      standings: computeStandings(players, d.pairings),
    };
  });
  const deltas = computeRatingDeltas(season.tiers.length, divisionsForRating);
  const deltasByPlayer = new Map(deltas.map((d) => [d.playerId, d]));

  const unfinishedPairings = season.divisions.reduce((sum, d) => {
    const expected = (d.members.length * (d.members.length - 1)) / 2;
    return sum + Math.max(0, expected - d.pairings.length);
  }, 0);

  const divisions: EndSeasonDivisionRow[] = season.divisions.map((d, i): EndSeasonDivisionRow => ({
    divisionId: d.id,
    divisionName: d.name,
    tierName: d.tier.name,
    tierPosition: d.tier.position,
    standings: divisionsForRating[i]!.standings,
    members: divisionsForRating[i]!.members,
  }));

  return {
    season: { id: season.id, name: season.name },
    unfinishedPairings,
    divisions,
    deltasByPlayer,
  };
}

// ── /admin/seasons/[id]/bulk-import ──────────────────────────────────

export interface BulkImportSeasonContext {
  id: string;
  name: string;
  divisions: Array<{ id: string; name: string }>;
}

export async function loadBulkImportSeasonContext(seasonId: string): Promise<BulkImportSeasonContext | null> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      id: true,
      name: true,
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        select: { id: true, name: true },
      },
    },
  });
  if (!season) return null;
  return season;
}

// ── /admin/deck-bans ─────────────────────────────────────────────────

export interface DeckBansPresetSummary {
  id: string;
  name: string;
  decks: string[];
  stakes: string[];
  seasonCount: number;
}

export interface DeckBansPageData {
  presets: DeckBansPresetSummary[];
  selected: DeckBansPresetSummary | null;
}

export async function loadDeckBansPage(selectedIdParam: string | undefined): Promise<DeckBansPageData> {
  const rows = await prisma.matchConfigPreset.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      decks: true,
      stakes: true,
      _count: { select: { seasons: true } },
    },
  });
  const presets: DeckBansPresetSummary[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    decks: p.decks,
    stakes: p.stakes,
    seasonCount: p._count.seasons,
  }));
  const selected = selectedIdParam
    ? presets.find((p) => p.id === selectedIdParam) ?? null
    : presets[0] ?? null;
  return { presets, selected };
}

// ── /admin/players ───────────────────────────────────────────────────

export interface PlayersPageNav {
  seasons: Array<{ id: string; name: string; isActive: boolean }>;
  divisionsInSelectedSeason: Array<{ id: string; name: string; tierPosition: number; tierName: string }>;
  selectedDivision: { id: string; name: string; tierPosition: number; tierName: string } | null;
}

// Header pickers: list of seasons + (if a season is selected) its
// divisions. Cheap — used by both modes of /admin/players.
export async function loadPlayersPageNav(opts: {
  seasonId?: string;
  divisionId?: string;
}): Promise<PlayersPageNav> {
  const seasons = await prisma.season.findMany({
    where: { endedAt: null },
    select: {
      id: true,
      name: true,
      isActive: true,
      tiers: {
        orderBy: { position: "asc" },
        select: {
          name: true,
          position: true,
          divisions: { orderBy: { groupNumber: "asc" }, select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
  });
  const selectedSeason = opts.seasonId ? seasons.find((s) => s.id === opts.seasonId) : null;
  const divisionsInSelectedSeason = selectedSeason
    ? selectedSeason.tiers.flatMap((t) =>
        t.divisions.map((d) => ({
          id: d.id,
          name: d.name,
          tierPosition: t.position,
          tierName: t.name,
        })),
      )
    : [];
  const selectedDivision = opts.divisionId
    ? divisionsInSelectedSeason.find((d) => d.id === opts.divisionId) ?? null
    : null;
  return {
    seasons: seasons.map((s) => ({ id: s.id, name: s.name, isActive: s.isActive })),
    divisionsInSelectedSeason,
    selectedDivision,
  };
}

export interface AdminDivisionMemberRow {
  membershipId: string;
  playerId: string;
  displayName: string;
  discordId: string;
  rating: number | null;
  droppedAt: Date | null;
  status: "ACTIVE" | "DROPPED";
  rank: number | null;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  unplayedOpponents: Array<{ playerId: string; displayName: string }>;
}

export interface AdminPlayersDivisionView {
  division: {
    id: string;
    name: string;
    seasonId: string;
    seasonName: string;
    tierName: string;
    tierPosition: number;
  };
  active: AdminDivisionMemberRow[];
  inactive: AdminDivisionMemberRow[];
}

export async function loadAdminPlayersDivisionView(
  divisionId: string,
): Promise<AdminPlayersDivisionView | null> {
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    include: {
      season: { select: { id: true, name: true } },
      tier: { select: { name: true, position: true } },
      members: { include: { player: true } },
      pairings: {
        where: { status: "CONFIRMED" },
        select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
      },
    },
  });
  if (!division) return null;

  const standings = computeStandings(
    division.members.map((m) => m.player),
    division.pairings,
  );
  const standingByPlayer = new Map(
    standings.map((r, i) => [r.player.id, { rank: i + 1, points: r.points, wins: r.wins, draws: r.draws, losses: r.losses }]),
  );

  const active = division.members.filter((m) => m.status === "ACTIVE");
  const rowFor = (m: typeof division.members[number]): AdminDivisionMemberRow => {
    const s = standingByPlayer.get(m.playerId);
    const playedThisPlayer = new Set(
      division.pairings
        .filter((p) => p.playerAId === m.playerId || p.playerBId === m.playerId)
        .map((p) => (p.playerAId === m.playerId ? p.playerBId : p.playerAId)),
    );
    const unplayed = active
      .filter((o) => o.playerId !== m.playerId && !playedThisPlayer.has(o.playerId))
      .map((o) => ({ playerId: o.playerId, displayName: o.player.displayName }));
    return {
      membershipId: m.id,
      playerId: m.playerId,
      displayName: m.player.displayName,
      discordId: m.player.discordId,
      rating: m.player.rating,
      droppedAt: m.droppedAt,
      status: m.status,
      rank: s?.rank ?? null,
      points: s?.points ?? 0,
      wins: s?.wins ?? 0,
      draws: s?.draws ?? 0,
      losses: s?.losses ?? 0,
      unplayedOpponents: unplayed,
    };
  };

  return {
    division: {
      id: division.id,
      name: division.name,
      seasonId: division.season.id,
      seasonName: division.season.name,
      tierName: division.tier.name,
      tierPosition: division.tier.position,
    },
    active: division.members.filter((m) => m.status === "ACTIVE").map(rowFor),
    inactive: division.members.filter((m) => m.status === "DROPPED").map(rowFor),
  };
}

export type AdminPlayersListSort = "name" | "rating-desc" | "rating-asc" | "ranked-only" | "unranked-only";

export interface AdminPlayersListRow {
  id: string;
  displayName: string;
  discordId: string;
  rating: number | null;
  membership: {
    divisionId: string;
    divisionName: string;
    seasonId: string;
    tierPosition: number;
    dropped: boolean;
    unplayedOpponents: Array<{ playerId: string; displayName: string }>;
  } | null;
}

export async function loadAdminPlayersListView(opts: {
  seasonId?: string;
  sort: AdminPlayersListSort;
}): Promise<AdminPlayersListRow[]> {
  const selectedSeason = opts.seasonId
    ? await prisma.season.findUnique({ where: { id: opts.seasonId }, select: { id: true } })
    : await prisma.season.findFirst({ where: { isActive: true }, select: { id: true } });

  const players = await prisma.player.findMany({
    select: {
      id: true,
      discordId: true,
      displayName: true,
      rating: true,
      memberships: {
        where: selectedSeason
          ? { division: { seasonId: selectedSeason.id } }
          : { division: { season: { isActive: true } } },
        select: {
          status: true,
          division: {
            select: {
              id: true,
              name: true,
              seasonId: true,
              tier: { select: { position: true } },
            },
          },
        },
      },
    },
  });
  let filtered = players;
  // When a season is selected, restrict to its members; otherwise show
  // every player (the active-season filter on memberships still trims
  // the badge column for non-current players).
  if (opts.seasonId) filtered = players.filter((p) => p.memberships.length > 0);

  // For the inline "Record set vs ..." form per row, pre-compute the
  // unplayed opponents for each (player, division) in one batch — avoids
  // a per-row roundtrip.
  let unplayedByKey = new Map<string, Array<{ playerId: string; displayName: string }>>();
  if (selectedSeason) {
    const members = await prisma.divisionMember.findMany({
      where: { seasonId: selectedSeason.id, status: "ACTIVE" },
      select: { divisionId: true, playerId: true, player: { select: { id: true, displayName: true } } },
    });
    const membersByDivision = new Map<string, Array<{ playerId: string; displayName: string }>>();
    for (const m of members) {
      const bucket = membersByDivision.get(m.divisionId) ?? [];
      bucket.push({ playerId: m.playerId, displayName: m.player.displayName });
      membersByDivision.set(m.divisionId, bucket);
    }
    const pairings = await prisma.pairing.findMany({
      where: { status: "CONFIRMED", division: { seasonId: selectedSeason.id } },
      select: { divisionId: true, playerAId: true, playerBId: true },
    });
    const playedKey = (divisionId: string, a: string, b: string) =>
      `${divisionId}|${a < b ? `${a}-${b}` : `${b}-${a}`}`;
    const playedSet = new Set(pairings.map((p) => playedKey(p.divisionId, p.playerAId, p.playerBId)));
    for (const [divisionId, list] of membersByDivision) {
      for (const meId of list.map((m) => m.playerId)) {
        const unplayed = list
          .filter((m) => m.playerId !== meId && !playedSet.has(playedKey(divisionId, meId, m.playerId)));
        unplayedByKey.set(`${divisionId}|${meId}`, unplayed);
      }
    }
  }

  // Apply sort + filter modes.
  let result = filtered.map((p): AdminPlayersListRow => {
    const m = p.memberships[0];
    const div = m?.division;
    return {
      id: p.id,
      displayName: p.displayName,
      discordId: p.discordId,
      rating: p.rating,
      membership: div
        ? {
            divisionId: div.id,
            divisionName: div.name,
            seasonId: div.seasonId,
            tierPosition: div.tier.position,
            dropped: m!.status === "DROPPED",
            unplayedOpponents: unplayedByKey.get(`${div.id}|${p.id}`) ?? [],
          }
        : null,
    };
  });
  if (opts.sort === "ranked-only") result = result.filter((p) => p.rating != null);
  if (opts.sort === "unranked-only") result = result.filter((p) => p.rating == null);
  if (opts.sort === "rating-desc") {
    result.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.displayName.localeCompare(b.displayName));
  } else if (opts.sort === "rating-asc") {
    result.sort((a, b) => (a.rating ?? -1) - (b.rating ?? -1) || a.displayName.localeCompare(b.displayName));
  } else {
    result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return result;
}

// ── /admin/rankings ──────────────────────────────────────────────────

export interface AdminRankingRow {
  id: string;
  discordId: string;
  displayName: string;
  rating: number | null;
  ratingNote: string | null;
  division: { name: string; tierPosition: number } | null;
  latestMmr: { rankedMmr: number | null; rankedTier: string | null } | null;
}

export async function loadAdminRankings(): Promise<AdminRankingRow[]> {
  const players = await prisma.player.findMany({
    select: {
      id: true,
      discordId: true,
      displayName: true,
      rating: true,
      ratingNote: true,
      memberships: {
        where: { division: { season: { isActive: true } } },
        select: {
          division: {
            select: {
              name: true,
              tier: { select: { position: true } },
            },
          },
        },
      },
    },
    orderBy: [{ rating: { sort: "desc", nulls: "last" } }, { displayName: "asc" }],
  });
  const playerIds = players.map((p) => p.id);
  const snapshots = playerIds.length === 0 ? [] : await prisma.playerMmrSnapshot.findMany({
    where: { playerId: { in: playerIds } },
    orderBy: { capturedAt: "desc" },
    distinct: ["playerId"],
    select: { playerId: true, rankedMmr: true, rankedTier: true },
  });
  const snapshotByPlayerId = new Map(
    snapshots.filter((s) => s.playerId).map((s) => [s.playerId!, { rankedMmr: s.rankedMmr, rankedTier: s.rankedTier }] as const),
  );
  return players.map((p) => {
    const m = p.memberships[0];
    return {
      id: p.id,
      discordId: p.discordId,
      displayName: p.displayName,
      rating: p.rating,
      ratingNote: p.ratingNote,
      division: m
        ? { name: m.division.name, tierPosition: m.division.tier.position }
        : null,
      latestMmr: snapshotByPlayerId.get(p.id) ?? null,
    };
  });
}

export async function loadAdminDivisionsIndex(): Promise<AdminDivisionsPageData> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      targetGroupSize: true,
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
              targetSize: true,
              _count: { select: { members: true } },
              pairings: { where: { status: "CONFIRMED" }, select: { id: true } },
            },
          },
        },
      },
    },
  });
  if (!season) return { season: null, tiers: [] };
  const tiers: AdminDivisionsTier[] = season.tiers.map((t) => ({
    id: t.id,
    name: t.name,
    position: t.position,
    divisions: t.divisions.map((d) => ({
      id: d.id,
      name: d.name,
      memberCount: d._count.members,
      targetSize: d.targetSize ?? season.targetGroupSize,
      confirmedPairingCount: d.pairings.length,
      expectedPairingCount: expectedPairings(d._count.members),
    })),
  }));
  return {
    season: { id: season.id, name: season.name, targetGroupSize: season.targetGroupSize },
    tiers,
  };
}
