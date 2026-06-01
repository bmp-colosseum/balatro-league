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

// ── /admin/signups/[id]/build ────────────────────────────────────────

export interface BuildSeasonSnapshot {
  rankedMmr: number | null;
  rankedTier: string | null;
  totalGames: number | null;
  winRatePct: number | null;
  peakMmr: number | null;
  wins: number | null;
  losses: number | null;
  capturedAt: Date;
  fetchError: string | null;
}

export interface BuildSeasonPriorInfo {
  rank: number;
  totalMembers: number;
  divisionName: string;
  tierName: string;
  seasonName: string;
  seasonStartedAt: Date;
}

export interface BuildSeasonSignup {
  id: string;
  discordId: string;
  displayName: string;
  signedUpAt: Date;
}

export interface BuildSeasonPlayerRow {
  id: string;
  discordId: string;
  displayName: string;
  rating: number | null;
  ratingNote: string | null;
}

export interface BuildSeasonPageData {
  round: {
    id: string;
    name: string;
    status: "OPEN" | "CLOSED" | "BUILT";
    signups: BuildSeasonSignup[];
  };
  sortedSignups: BuildSeasonSignup[];
  playerByDiscordId: Map<string, BuildSeasonPlayerRow>;
  snapshotByDiscordId: Map<string, BuildSeasonSnapshot>;
  priorSnapshotByDiscordId: Map<string, BuildSeasonSnapshot>;
  priorByPlayerId: Map<string, BuildSeasonPriorInfo>;
  skippedByPlayerId: Map<string, number>;
  templates: Array<{
    id: string;
    name: string;
    isLastUsed: boolean;
    config: Array<{ name: string; divisionCount: number }>;
  }>;
  initialTiers: Array<{ name: string; divisionCount: number }>;
  presets: Array<{ id: string; name: string }>;
  totalSlots: number;
  playerCount: number;
}

export type BuildSeasonResolution = "BUILT_REDIRECT" | "NOT_FOUND" | BuildSeasonPageData;

// Returns a discriminated union — caller decides what to do with BUILT
// (redirect to /admin/seasons) vs not-found (404).
export async function loadBuildSeasonPage(roundId: string): Promise<BuildSeasonResolution> {
  const [round, templatesRaw, lastUsed, presets] = await Promise.all([
    prisma.signupRound.findUnique({
      where: { id: roundId },
      include: {
        signups: {
          where: { withdrawn: false },
          orderBy: { signedUpAt: "asc" },
          select: { id: true, discordId: true, displayName: true, signedUpAt: true },
        },
      },
    }),
    prisma.tierTemplate.findMany({
      orderBy: [{ isLastUsed: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isLastUsed: true, config: true },
    }),
    prisma.tierTemplate.findUnique({ where: { name: "Last used" }, select: { config: true } }),
    prisma.matchConfigPreset.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!round) return "NOT_FOUND";
  if (round.status === "BUILT") return "BUILT_REDIRECT";

  const discordIds = round.signups.map((s) => s.discordId);
  const existingPlayers = await prisma.player.findMany({
    where: { discordId: { in: discordIds } },
    select: { id: true, discordId: true, displayName: true, rating: true, ratingNote: true },
  });
  const playerByDiscordId = new Map(existingPlayers.map((p) => [p.discordId, p]));

  // BMP MMR snapshots — fetch once, group in JS to get latest + 2nd-latest
  // per discord id without a second distinct query.
  const allSnapshots = discordIds.length === 0 ? [] : await prisma.playerMmrSnapshot.findMany({
    where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
    orderBy: { capturedAt: "desc" },
    select: {
      discordId: true,
      rankedMmr: true,
      rankedTier: true,
      totalGames: true,
      winRatePct: true,
      peakMmr: true,
      wins: true,
      losses: true,
      capturedAt: true,
      fetchError: true,
    },
  });
  const snapshotsByDiscordId = new Map<string, typeof allSnapshots>();
  for (const s of allSnapshots) {
    const arr = snapshotsByDiscordId.get(s.discordId) ?? [];
    arr.push(s);
    snapshotsByDiscordId.set(s.discordId, arr);
  }
  const stripDid = (s: typeof allSnapshots[number]): BuildSeasonSnapshot => ({
    rankedMmr: s.rankedMmr,
    rankedTier: s.rankedTier,
    totalGames: s.totalGames,
    winRatePct: s.winRatePct,
    peakMmr: s.peakMmr,
    wins: s.wins,
    losses: s.losses,
    capturedAt: s.capturedAt,
    fetchError: s.fetchError,
  });
  const snapshotByDiscordId = new Map(
    Array.from(snapshotsByDiscordId.entries()).map(([did, arr]) => [did, stripDid(arr[0]!)] as const),
  );
  const priorSnapshotByDiscordId = new Map(
    Array.from(snapshotsByDiscordId.entries())
      .filter(([, arr]) => arr.length >= 2)
      .map(([did, arr]) => [did, stripDid(arr[1]!)] as const),
  );

  // Last-season rank for returners.
  const returnerPlayerIds = existingPlayers.map((p) => p.id);
  const priorMemberships = returnerPlayerIds.length === 0 ? [] : await prisma.divisionMember.findMany({
    where: { playerId: { in: returnerPlayerIds }, status: "ACTIVE" },
    include: {
      division: {
        include: {
          tier: true,
          season: { select: { id: true, name: true, startedAt: true } },
          members: { where: { status: "ACTIVE" }, include: { player: true } },
          pairings: {
            where: { status: "CONFIRMED" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
      },
    },
  });
  const mostRecentMembershipByPlayerId = new Map<string, typeof priorMemberships[0]>();
  for (const m of priorMemberships) {
    const cur = mostRecentMembershipByPlayerId.get(m.playerId);
    if (!cur || m.division.season.startedAt > cur.division.season.startedAt) {
      mostRecentMembershipByPlayerId.set(m.playerId, m);
    }
  }
  const priorByPlayerId = new Map<string, BuildSeasonPriorInfo>();
  const standingsByDivisionId = new Map<string, ReturnType<typeof computeStandings>>();
  for (const m of mostRecentMembershipByPlayerId.values()) {
    const div = m.division;
    let rows = standingsByDivisionId.get(div.id);
    if (!rows) {
      rows = computeStandings(div.members.map((mm) => mm.player), div.pairings);
      standingsByDivisionId.set(div.id, rows);
    }
    const rank = rows.findIndex((r) => r.player.id === m.playerId) + 1;
    priorByPlayerId.set(m.playerId, {
      rank: rank || 0,
      totalMembers: div.members.length,
      divisionName: div.name,
      tierName: div.tier.name,
      seasonName: div.season.name,
      seasonStartedAt: div.season.startedAt,
    });
  }

  // Seasons skipped between prior membership and now ("gap returner" indicator).
  const endedSeasons = await prisma.season.findMany({
    where: { endedAt: { not: null } },
    select: { startedAt: true },
  });
  const skippedByPlayerId = new Map<string, number>();
  for (const [pid, info] of priorByPlayerId) {
    const skipped = endedSeasons.filter((s) => s.startedAt > info.seasonStartedAt).length;
    skippedByPlayerId.set(pid, skipped);
  }

  // Smart initial sort: returners (people with a real prior-season
  // membership AND a Player.rating from end-season recompute) first,
  // ordered by their rating desc. Then new players, ordered by BMP MMR
  // desc. This gives admin a single ordered list where the strongest
  // league signal (rating) ranks ahead of the weakest (BMP MMR) — and
  // drag-to-reorder lets them tune from there.
  const sortedSignups = [...round.signups].sort((a, b) => {
    const playerA = playerByDiscordId.get(a.discordId);
    const playerB = playerByDiscordId.get(b.discordId);
    const aIsReturner = playerA != null && priorByPlayerId.has(playerA.id);
    const bIsReturner = playerB != null && priorByPlayerId.has(playerB.id);
    // Returners always rank above non-returners — league signal > MMR.
    if (aIsReturner !== bIsReturner) return aIsReturner ? -1 : 1;
    if (aIsReturner && bIsReturner) {
      // Both returners → sort by Player.rating desc (null = lowest).
      const ra = playerA?.rating ?? -1;
      const rb = playerB?.rating ?? -1;
      if (ra !== rb) return rb - ra;
    }
    // Both new (or returners tied on rating) → BMP MMR desc.
    const aMmr = snapshotByDiscordId.get(a.discordId)?.rankedMmr ?? -1;
    const bMmr = snapshotByDiscordId.get(b.discordId)?.rankedMmr ?? -1;
    if (aMmr !== bMmr) return bMmr - aMmr;
    return a.signedUpAt.getTime() - b.signedUpAt.getTime();
  });

  const templates = templatesRaw.map((t) => ({
    id: t.id,
    name: t.name,
    isLastUsed: t.isLastUsed,
    config: parseTemplateConfig(t.config),
  }));
  const initialTiers = lastUsed ? parseTemplateConfig(lastUsed.config) : DEFAULT_TIERS_FALLBACK;
  const totalSlots = initialTiers.reduce((sum, t) => sum + t.divisionCount * 5, 0);

  return {
    round: { id: round.id, name: round.name, status: round.status, signups: round.signups },
    sortedSignups,
    playerByDiscordId,
    snapshotByDiscordId,
    priorSnapshotByDiscordId,
    priorByPlayerId,
    skippedByPlayerId,
    templates,
    initialTiers,
    presets,
    totalSlots,
    playerCount: round.signups.length,
  };
}

// ── /admin/seasons/[id] ──────────────────────────────────────────────

export interface AdminSeasonDetailData {
  season: NonNullable<Awaited<ReturnType<typeof fetchAdminSeasonDetail>>>;
  presets: Array<{ id: string; name: string; decks: string[]; stakes: string[] }>;
  defaultPreset: { id: string; name: string; decks: string[]; stakes: string[] } | null;
  signupRound: {
    id: string;
    status: "OPEN" | "CLOSED" | "BUILT";
    channelId: string;
    _count: { signups: number };
  } | null;
  templates: Array<{
    id: string;
    name: string;
    isLastUsed: boolean;
    config: Array<{ name: string; divisionCount: number }>;
  }>;
  initialTiers: Array<{ name: string; divisionCount: number }>;
  totalMembers: number;
  totalConfirmed: number;
  totalExpected: number;
  channels: Array<{ id: string; name: string }>;
}

async function fetchAdminSeasonDetail(id: string) {
  return prisma.season.findUnique({
    where: { id },
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
      matchConfigPreset: true,
    },
  });
}

export async function loadAdminSeasonDetail(
  id: string,
  opts: {
    listGuildTextChannels: (guildId: string) => Promise<Array<{ id: string; name: string }>>;
    guildId: string | undefined;
  },
): Promise<AdminSeasonDetailData | null> {
  const [season, presets, defaultPreset, signupRound, templatesRaw, lastUsed] = await Promise.all([
    fetchAdminSeasonDetail(id),
    prisma.matchConfigPreset.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, decks: true, stakes: true },
    }),
    prisma.matchConfigPreset.findUnique({
      where: { name: "Default" },
      select: { id: true, name: true, decks: true, stakes: true },
    }),
    prisma.signupRound.findFirst({
      where: { resultingSeasonId: id },
      select: {
        id: true,
        status: true,
        channelId: true,
        _count: { select: { signups: true } },
      },
    }),
    prisma.tierTemplate.findMany({
      orderBy: [{ isLastUsed: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isLastUsed: true, config: true },
    }),
    prisma.tierTemplate.findUnique({ where: { name: "Last used" }, select: { config: true } }),
  ]);
  if (!season) return null;

  const templates = templatesRaw.map((t) => ({
    id: t.id,
    name: t.name,
    isLastUsed: t.isLastUsed,
    config: parseTemplateConfig(t.config),
  }));
  const initialTiers = lastUsed ? parseTemplateConfig(lastUsed.config) : DEFAULT_TIERS_FALLBACK;
  const totalMembers = season.divisions.reduce((sum, d) => sum + d.members.length, 0);
  const totalConfirmed = season.divisions.reduce((sum, d) => sum + d.pairings.length, 0);
  const totalExpected = season.divisions.reduce((sum, d) => {
    const n = d.members.filter((m) => m.status === "ACTIVE").length;
    return sum + (n < 2 ? 0 : (n * (n - 1)) / 2);
  }, 0);
  const needsChannels = !signupRound && !season.endedAt;
  const channels = needsChannels && opts.guildId ? await opts.listGuildTextChannels(opts.guildId) : [];

  return {
    season,
    presets,
    defaultPreset,
    signupRound,
    templates,
    initialTiers,
    totalMembers,
    totalConfirmed,
    totalExpected,
    channels,
  };
}

// ── /admin/seasons (index) ───────────────────────────────────────────

export type AdminSeasonsRound = {
  id: string;
  status: "OPEN" | "CLOSED" | "BUILT";
  channelId: string;
  resultingSeasonId: string | null;
  _count: { signups: number };
};

export interface AdminSeasonsPageData {
  // Kept as the existing Prisma shape — the page render was built against
  // it. The loader's job here is to encapsulate the FETCH (8 parallel
  // queries) rather than reshape data; collapsing the includes would be
  // a separate, bigger change.
  seasons: Awaited<ReturnType<typeof fetchAdminSeasons>>;
  templates: Array<{
    id: string;
    name: string;
    isLastUsed: boolean;
    config: Array<{ name: string; divisionCount: number }>;
  }>;
  initialTierConfig: Array<{ name: string; divisionCount: number }>;
  presets: Array<{ id: string; name: string; decks: string[]; stakes: string[] }>;
  defaultPreset: { id: string; name: string; decks: string[]; stakes: string[] } | null;
  roundsBySeason: Map<string, AdminSeasonsRound>;
  channels: Array<{ id: string; name: string }>;
  archivedCount: number;
}

const DEFAULT_TIERS_FALLBACK = [
  { name: "Legendary", divisionCount: 1 },
  { name: "Rare", divisionCount: 6 },
  { name: "Uncommon", divisionCount: 6 },
  { name: "Common", divisionCount: 6 },
];

async function fetchAdminSeasons(showArchived: boolean) {
  return prisma.season.findMany({
    where: showArchived ? {} : { archivedAt: null },
    include: {
      _count: { select: { divisions: true } },
      tiers: { orderBy: { position: "asc" }, include: { _count: { select: { divisions: true } } } },
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: {
          tier: true,
          _count: { select: { members: true, pairings: true } },
        },
      },
      matchConfigPreset: true,
    },
    orderBy: [{ isActive: "desc" }, { startedAt: "desc" }],
  });
}

export async function loadAdminSeasonsIndex(opts: {
  showArchived: boolean;
  listGuildTextChannels: (guildId: string) => Promise<Array<{ id: string; name: string }>>;
  guildId: string | undefined;
}): Promise<AdminSeasonsPageData> {
  const [seasons, templatesRaw, lastUsed, presets, defaultPreset, signupRounds, archivedCount] =
    await Promise.all([
      fetchAdminSeasons(opts.showArchived),
      prisma.tierTemplate.findMany({
        orderBy: [{ isLastUsed: "desc" }, { name: "asc" }],
        select: { id: true, name: true, isLastUsed: true, config: true },
      }),
      prisma.tierTemplate.findUnique({ where: { name: "Last used" }, select: { config: true } }),
      prisma.matchConfigPreset.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, decks: true, stakes: true },
      }),
      prisma.matchConfigPreset.findUnique({
        where: { name: "Default" },
        select: { id: true, name: true, decks: true, stakes: true },
      }),
      prisma.signupRound.findMany({
        where: { resultingSeasonId: { not: null } },
        select: {
          id: true,
          status: true,
          channelId: true,
          resultingSeasonId: true,
          _count: { select: { signups: true } },
        },
      }),
      prisma.season.count({ where: { archivedAt: { not: null } } }),
    ]);

  const needsChannels = seasons.some(
    (s) => !s.endedAt && !signupRounds.find((r) => r.resultingSeasonId === s.id),
  );
  const channels =
    needsChannels && opts.guildId ? await opts.listGuildTextChannels(opts.guildId) : [];

  const templates = templatesRaw.map((t) => ({
    id: t.id,
    name: t.name,
    isLastUsed: t.isLastUsed,
    config: parseTemplateConfig(t.config),
  }));
  const initialTierConfig = lastUsed ? parseTemplateConfig(lastUsed.config) : DEFAULT_TIERS_FALLBACK;
  const roundsBySeason = new Map(
    signupRounds.map((r) => [r.resultingSeasonId!, r as AdminSeasonsRound]),
  );

  return {
    seasons,
    templates,
    initialTierConfig,
    presets,
    defaultPreset,
    roundsBySeason,
    channels,
    archivedCount,
  };
}

// ── /admin/divisions/[id] ────────────────────────────────────────────

export interface AdminDivisionDetailMember {
  id: string;
  playerId: string;
  status: "ACTIVE" | "DROPPED";
  droppedAt: Date | null;
  player: { id: string; displayName: string; discordId: string; rating: number | null };
}

export interface AdminDivisionDetailPairing {
  id: string;
  status: "PENDING" | "CONFIRMED" | "DISPUTED" | "CANCELLED";
  playerAId: string;
  playerBId: string;
  gamesWonA: number;
  gamesWonB: number;
  reportedAt: Date | null;
  confirmedAt: Date | null;
  playerA: { id: string; displayName: string };
  playerB: { id: string; displayName: string };
}

export interface AdminDivisionDetailShootout {
  playerAId: string;
  playerBId: string;
  winnerId: string;
  recordedBy: string;
  recordedAt: Date;
  notes: string | null;
}

export interface AdminDivisionDetailData {
  division: {
    id: string;
    name: string;
    targetSize: number | null;
    seasonId: string;
    seasonName: string;
    seasonTargetGroupSize: number;
    tierName: string;
    tierPosition: number;
  };
  members: AdminDivisionDetailMember[];
  pairings: AdminDivisionDetailPairing[];
  shootouts: AdminDivisionDetailShootout[];
  standings: Array<ReturnType<typeof computeStandings>[number] & { dropped: boolean }>;
  unplayed: Array<{
    a: { id: string; displayName: string };
    b: { id: string; displayName: string };
  }>;
  playerById: Map<string, { id: string; displayName: string }>;
}

export async function loadAdminDivisionDetail(
  divisionId: string,
): Promise<AdminDivisionDetailData | null> {
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    include: {
      season: { select: { id: true, name: true, targetGroupSize: true } },
      tier: { select: { name: true, position: true } },
      members: { include: { player: true }, orderBy: { joinedAt: "asc" } },
      pairings: {
        include: { playerA: true, playerB: true },
        orderBy: [{ status: "asc" }, { reportedAt: "desc" }],
      },
      shootouts: {
        select: { playerAId: true, playerBId: true, winnerId: true, recordedBy: true, recordedAt: true, notes: true },
      },
    },
  });
  if (!division) return null;

  const droppedIds = new Set(
    division.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
  );
  const confirmedPairings = division.pairings.filter((p) => p.status === "CONFIRMED");
  const standings = computeStandings(
    division.members.map((m) => m.player),
    confirmedPairings.map((p) => ({
      playerAId: p.playerAId,
      playerBId: p.playerBId,
      gamesWonA: p.gamesWonA,
      gamesWonB: p.gamesWonB,
    })),
    division.shootouts,
  ).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));

  const playerById = new Map(
    division.members.map((m) => [m.playerId, { id: m.player.id, displayName: m.player.displayName }]),
  );

  const activeMembers = division.members.filter((m) => m.status === "ACTIVE");
  const playedKey = (a: string, b: string) => {
    const [x, y] = a < b ? [a, b] : [b, a];
    return `${x}-${y}`;
  };
  const playedSet = new Set(division.pairings.map((p) => playedKey(p.playerAId, p.playerBId)));
  const unplayed: AdminDivisionDetailData["unplayed"] = [];
  for (let i = 0; i < activeMembers.length; i++) {
    for (let j = i + 1; j < activeMembers.length; j++) {
      const a = activeMembers[i]!.player;
      const b = activeMembers[j]!.player;
      if (!playedSet.has(playedKey(a.id, b.id))) {
        unplayed.push({ a, b });
      }
    }
  }

  return {
    division: {
      id: division.id,
      name: division.name,
      targetSize: division.targetSize,
      seasonId: division.season.id,
      seasonName: division.season.name,
      seasonTargetGroupSize: division.season.targetGroupSize,
      tierName: division.tier.name,
      tierPosition: division.tier.position,
    },
    members: division.members.map((m): AdminDivisionDetailMember => ({
      id: m.id,
      playerId: m.playerId,
      status: m.status,
      droppedAt: m.droppedAt,
      player: {
        id: m.player.id,
        displayName: m.player.displayName,
        discordId: m.player.discordId,
        rating: m.player.rating,
      },
    })),
    pairings: division.pairings.map((p): AdminDivisionDetailPairing => ({
      id: p.id,
      status: p.status,
      playerAId: p.playerAId,
      playerBId: p.playerBId,
      gamesWonA: p.gamesWonA,
      gamesWonB: p.gamesWonB,
      reportedAt: p.reportedAt,
      confirmedAt: p.confirmedAt,
      playerA: { id: p.playerA.id, displayName: p.playerA.displayName },
      playerB: { id: p.playerB.id, displayName: p.playerB.displayName },
    })),
    shootouts: division.shootouts,
    standings,
    unplayed,
    playerById,
  };
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
