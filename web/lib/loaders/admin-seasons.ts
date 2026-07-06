// Admin season loaders: templates / season list / season detail /
// build-season / end-season preview / signup MMR overview. Relocated
// verbatim from admin.ts (no behavior change).
//
// Conventions:
//   - All admin loaders assume requireAdmin() ran in the page
//   - Return shapes are page-specific; never expose raw Prisma types
//   - Cached standings come from loadDivisionStandings, not inline
//     computeStandings

import { prisma } from "@/lib/prisma";
import { bannedDiscordIdSet } from "@/lib/bans";
import { isScheduleLocked } from "@/lib/schedule-locked";
import { byBestBmpSnapshot } from "@/lib/bmp-snapshots";
import { computeStandings } from "@/lib/standings";
import { computeRatingDeltas, type DivisionForRating } from "@/lib/end-season";
import { formatSeasonLabel } from "@/lib/format-season";
import {
  expectedMatchesBySeason,
  parseTemplateConfig,
  DEFAULT_TIERS_FALLBACK,
} from "@/lib/loaders/admin-shared";

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

// League rules templates shaped for the picker on the season detail admin
// panel (id/name/isDefault, default first). Cheap select — loaded inline on
// the page rather than threaded through loadAdminSeasonDetail.
export interface RulesTemplatePickerRow {
  id: string;
  name: string;
  isDefault: boolean;
}

export async function loadRulesTemplatePickerOptions(): Promise<RulesTemplatePickerRow[]> {
  return prisma.leagueRulesTemplate.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, isDefault: true },
  });
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
          matches: { where: { status: "CONFIRMED", format: "LEAGUE_BO2" } },
        },
      },
    },
  });
  if (!season) return null;

  const divisionsForRating: DivisionForRating[] = season.divisions.map((d) => {
    const players = d.members.map((m) => m.player);
    return {
      tierPosition: d.tier.position,
      divisionGroupNumber: d.groupNumber,
      promoteCount: d.promoteCount,
      relegateCount: d.relegateCount,
      members: d.members.map((m) => ({
        playerId: m.playerId,
        status: m.status,
        currentRating: m.player.rating,
      })),
      standings: computeStandings(players, d.matches),
    };
  });
  const deltas = computeRatingDeltas(season.tiers.length, divisionsForRating);
  const deltasByPlayer = new Map(deltas.map((d) => [d.playerId, d]));

  // Expected counts are schedule-aware: a locked (graph) schedule expects only its
  // pre-created matchups, not a full round-robin — else the warning fires forever.
  const activeByDivision = new Map(
    season.divisions.map((d) => [d.id, new Set(d.members.filter((m) => m.status === "ACTIVE").map((m) => m.playerId))]),
  );
  const expectedByDivision = await expectedMatchesBySeason(seasonId, activeByDivision, season.scheduleLocked);
  const unfinishedPairings = season.divisions.reduce((sum, d) => {
    // Active players only — a void-dropped player's missing games shouldn't read
    // as "unfinished". d.matches is CONFIRMED, and a voided game is a CONFIRMED
    // 0-0, so it correctly counts as finished here too.
    const activeIds = activeByDivision.get(d.id)!;
    const expected = expectedByDivision.get(d.id) ?? 0;
    const playedActive = d.matches.filter((m) => activeIds.has(m.playerAId) && activeIds.has(m.playerBId)).length;
    return sum + Math.max(0, expected - playedActive);
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
    season: { id: season.id, name: formatSeasonLabel(season) },
    unfinishedPairings,
    divisions,
    deltasByPlayer,
  };
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
  // Snapshot of Player.rating at the moment that prior season ended.
  // Null for memberships predating the finalGlobalRank column or
  // still-active seasons. Surfaced on the build page so admin sees
  // "they finished as global #47" while deciding placement.
  finalGlobalRank: number | null;
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
  hiddenMmr: number | null;
}

export interface BuildSeasonPageData {
  round: {
    id: string;
    name: string;
    status: "OPEN" | "CLOSED" | "BUILT";
    resultingSeasonId: string | null;
    signups: BuildSeasonSignup[];
  };
  sortedSignups: BuildSeasonSignup[];
  playerByDiscordId: Map<string, BuildSeasonPlayerRow>;
  snapshotByDiscordId: Map<string, BuildSeasonSnapshot>;
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
    select: { id: true, discordId: true, displayName: true, rating: true, ratingNote: true, hiddenMmr: true },
  });
  const playerByDiscordId = new Map(existingPlayers.map((p) => [p.discordId, p]));

  // BMP MMR snapshots. Picking strategy per discord id (in order):
  //   1. The current BMP season's snapshot if it has a non-null mmr
  //   2. The most-recent prior BMP season's snapshot with non-null mmr
  //      (e.g. player skipped current season but played last one)
  //   3. Null — no usable MMR data anywhere
  // This is the "fall back to previous season when current is missing"
  // behavior — a player who hasn't played the live BMP season still
  // shows their last-season MMR as the placement proxy.
  //
  // bmpSeason is a tag like "season6"; we sort by the numeric suffix
  // so "season10" beats "season9", then by capturedAt DESC as the
  // tiebreaker for repeat captures of the same season.
  const allSnapshots = discordIds.length === 0 ? [] : await prisma.playerMmrSnapshot.findMany({
    where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
    orderBy: { capturedAt: "desc" },
    select: {
      discordId: true,
      bmpSeason: true,
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
  // Sort each player's snapshots so [0] is the preferred one (latest
  // tagged season, falling back to ad-hoc captures by recency).
  for (const arr of snapshotsByDiscordId.values()) {
    arr.sort(byBestBmpSnapshot);
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

  // Last-season rank for returners.
  const returnerPlayerIds = existingPlayers.map((p) => p.id);
  const priorMemberships = returnerPlayerIds.length === 0 ? [] : await prisma.divisionMember.findMany({
    where: { playerId: { in: returnerPlayerIds }, status: "ACTIVE" },
    include: {
      // finalGlobalRank doesn't come through `include` by default —
      // pull it explicitly via `select` would force restating every
      // field, so leave include in place and rely on Prisma surfacing
      // scalar fields automatically.
      division: {
        include: {
          tier: true,
          season: { select: { id: true, number: true, subtitle: true, startedAt: true } },
          members: { where: { status: "ACTIVE" }, include: { player: true } },
          matches: {
            where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
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
      rows = computeStandings(div.members.map((mm) => mm.player), div.matches);
      standingsByDivisionId.set(div.id, rows);
    }
    const rank = rows.findIndex((r) => r.player.id === m.playerId) + 1;
    priorByPlayerId.set(m.playerId, {
      rank: rank || 0,
      totalMembers: div.members.length,
      divisionName: div.name,
      tierName: div.tier.name,
      seasonName: formatSeasonLabel(div.season),
      seasonStartedAt: div.season.startedAt,
      finalGlobalRank: m.finalGlobalRank,
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

  // Initial sort: Player.rating ASC (rating = rank, 1 = best).
  // Returners with a league rank come first by their rank value.
  // New players (no rank) fall to the bottom, where they're ordered
  // among themselves by BMP MMR DESC (higher MMR = stronger player
  // = lower position in the unranked tail).
  const sortedSignups = [...round.signups].sort((a, b) => {
    const playerA = playerByDiscordId.get(a.discordId);
    const playerB = playerByDiscordId.get(b.discordId);
    const aRank = playerA?.rating ?? null;
    const bRank = playerB?.rating ?? null;
    // Ranked players always sort above unranked.
    if (aRank !== null && bRank === null) return -1;
    if (aRank === null && bRank !== null) return 1;
    if (aRank !== null && bRank !== null) {
      if (aRank !== bRank) return aRank - bRank;
    }
    // Both unranked (or tied on rank): order by BMP MMR desc as the
    // best available proxy for skill.
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
    round: { id: round.id, name: round.name, status: round.status, resultingSeasonId: round.resultingSeasonId, signups: round.signups },
    sortedSignups,
    playerByDiscordId,
    snapshotByDiscordId,
    priorByPlayerId,
    skippedByPlayerId,
    templates,
    initialTiers,
    presets,
    totalSlots,
    playerCount: round.signups.length,
  };
}

// ── /admin/signups/[id] — pre-season MMR distribution ────────────────

export interface SignupMmrRow {
  discordId: string;
  globalName: string | null; // account-level Discord display name
  username: string; // the @handle captured at signup
  inGuild: boolean | null;
  mmr: number | null; // current ranked MMR
  peakMmr: number | null;
  tier: string | null;
  totalGames: number | null;
  winRatePct: number | null;
  // Which BMP season the shown numbers are from. Compare to the overview's
  // bmpCurrentSeason to flag a fallback ("hasn't played this season").
  bmpSeason: string | null;
  // League ban (active) + set completion in the CURRENT active season: how many
  // of their scheduled matches they played (played/scheduled). null = they
  // weren't in the active season at all (new signup / gap returner) — distinct
  // from a no-show (in the season, played 0 of N).
  banned: boolean;
  setsThisSeason: { played: number; scheduled: number } | null;
}
export interface SignupMmrTier {
  tier: string;
  count: number;
  avgMmr: number;
}
export interface SignupMmrOverview {
  round: { id: string; name: string; status: string; signupCount: number; resultingSeasonId: string | null; resultingSeasonEndedAt: Date | null };
  rows: SignupMmrRow[]; // sorted by mmr desc, no-data last
  withData: number;
  withoutData: number;
  min: number | null;
  max: number | null;
  median: number | null;
  avg: number | null;
  byTier: SignupMmrTier[]; // sorted strongest tier first (by avg mmr)
  bmpCurrentSeason: string | null;
}

// Roster of a signup round joined to each signup's best BMP MMR snapshot (by
// discordId — works before they're materialized into Players), plus summary
// stats + tier distribution. Read-only "how strong is this signup pool" view.
export async function loadSignupMmrOverview(roundId: string): Promise<SignupMmrOverview | null> {
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: {
      signups: {
        where: { withdrawn: false },
        select: { discordId: true, displayName: true, globalName: true, inGuild: true },
      },
    },
  });
  if (!round) return null;

  // Resulting season's ended state → the detail header shows "ENDED" instead of a
  // perpetual "BUILT" once the season this round built has finished.
  const resultingSeasonEndedAt = round.resultingSeasonId
    ? (await prisma.season.findUnique({ where: { id: round.resultingSeasonId }, select: { endedAt: true } }))?.endedAt ?? null
    : null;

  const discordIds = round.signups.map((s) => s.discordId);
  const [snaps, bmpSeasonRow] = await Promise.all([
    discordIds.length === 0 ? Promise.resolve([]) : prisma.playerMmrSnapshot.findMany({
      where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
      orderBy: { capturedAt: "desc" },
      select: { discordId: true, bmpSeason: true, rankedMmr: true, peakMmr: true, rankedTier: true, totalGames: true, winRatePct: true, capturedAt: true },
    }),
    prisma.leagueConfig.findUnique({ where: { key: "bmp_current_season" }, select: { value: true } }),
  ]);
  const bmpCurrentSeason = bmpSeasonRow?.value ?? null;
  // Best snapshot per discordId: latest tagged BMP season, then newest capture.
  const byDid = new Map<string, typeof snaps>();
  for (const s of snaps) {
    const arr = byDid.get(s.discordId) ?? [];
    arr.push(s);
    byDid.set(s.discordId, arr);
  }
  const best = new Map<string, (typeof snaps)[number]>();
  for (const [did, arr] of byDid) {
    arr.sort(byBestBmpSnapshot);
    best.set(did, arr[0]!);
  }

  // Ban status + this-season set completion (played/scheduled), keyed by discordId.
  const players = discordIds.length
    ? await prisma.player.findMany({ where: { discordId: { in: discordIds } }, select: { id: true, discordId: true } })
    : [];
  const discordByPlayerId = new Map(players.map((p) => [p.id, p.discordId]));
  const bannedSet = await bannedDiscordIdSet(discordIds);

  // played/scheduled per active-season member; absent = they weren't in the season.
  const setsByDiscord = new Map<string, { played: number; scheduled: number }>();
  const activeSeason = players.length
    ? await prisma.season.findFirst({
        where: { isActive: true },
        select: {
          scheduleLocked: true,
          divisions: {
            select: {
              members: { where: { status: "ACTIVE" }, select: { playerId: true } },
              matches: {
                where: { format: "LEAGUE_BO2" },
                select: { playerAId: true, playerBId: true, status: true, gamesWonA: true, gamesWonB: true },
              },
            },
          },
        },
      })
    : null;
  if (activeSeason) {
    for (const d of activeSeason.divisions) {
      const activeIds = new Set(d.members.map((m) => m.playerId));
      const locked = isScheduleLocked(activeSeason.scheduleLocked, d.matches);
      const rrTotal = Math.max(0, activeIds.size - 1);
      const played = new Map<string, number>();
      const scheduled = new Map<string, number>();
      for (const m of d.matches) {
        if (m.status === "CANCELLED") continue;
        for (const pid of [m.playerAId, m.playerBId]) {
          if (!activeIds.has(pid)) continue;
          scheduled.set(pid, (scheduled.get(pid) ?? 0) + 1);
          if (m.status === "CONFIRMED") played.set(pid, (played.get(pid) ?? 0) + 1);
        }
      }
      for (const pid of activeIds) {
        const did = discordByPlayerId.get(pid);
        if (!did) continue;
        setsByDiscord.set(did, { played: played.get(pid) ?? 0, scheduled: locked ? scheduled.get(pid) ?? 0 : rrTotal });
      }
    }
  }

  const rows: SignupMmrRow[] = round.signups
    .map((s) => {
      const b = best.get(s.discordId);
      return {
        discordId: s.discordId,
        globalName: s.globalName,
        username: s.displayName,
        inGuild: s.inGuild,
        mmr: b?.rankedMmr ?? null,
        peakMmr: b?.peakMmr ?? null,
        tier: b?.rankedTier ?? null,
        totalGames: b?.totalGames ?? null,
        winRatePct: b?.winRatePct ?? null,
        bmpSeason: b?.bmpSeason ?? null,
        banned: bannedSet.has(s.discordId),
        setsThisSeason: setsByDiscord.get(s.discordId) ?? null,
      };
    })
    .sort((a, b) => {
      const an = a.globalName ?? a.username;
      const bn = b.globalName ?? b.username;
      if (a.mmr === null && b.mmr === null) return an.localeCompare(bn);
      if (a.mmr === null) return 1;
      if (b.mmr === null) return -1;
      return b.mmr - a.mmr;
    });

  const mmrs = rows.map((r) => r.mmr).filter((m): m is number => m !== null).sort((a, b) => a - b);
  const n = mmrs.length;
  const median =
    n === 0 ? null : n % 2 === 1 ? mmrs[(n - 1) / 2]! : Math.round((mmrs[n / 2 - 1]! + mmrs[n / 2]!) / 2);

  const tierStats = new Map<string, { count: number; sum: number }>();
  for (const r of rows) {
    if (r.tier && r.mmr !== null) {
      const t = tierStats.get(r.tier) ?? { count: 0, sum: 0 };
      t.count += 1;
      t.sum += r.mmr;
      tierStats.set(r.tier, t);
    }
  }
  const byTier: SignupMmrTier[] = Array.from(tierStats.entries())
    .map(([tier, s]) => ({ tier, count: s.count, avgMmr: Math.round(s.sum / s.count) }))
    .sort((a, b) => b.avgMmr - a.avgMmr);

  return {
    round: { id: round.id, name: round.name, status: round.status, signupCount: round.signups.length, resultingSeasonId: round.resultingSeasonId, resultingSeasonEndedAt },
    rows,
    withData: n,
    withoutData: rows.length - n,
    min: n ? mmrs[0]! : null,
    max: n ? mmrs[n - 1]! : null,
    median,
    avg: n ? Math.round(mmrs.reduce((s, m) => s + m, 0) / n) : null,
    byTier,
    bmpCurrentSeason,
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
    closedAt: Date | null;
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
  // Keyed by playerId — looked up by the draft editor to render
  // per-row chips (league rank, BMP MMR, prior-season global rank).
  memberContext: Map<string, AdminSeasonMemberContext>;
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
          // Members within a division come back in draft-mode display
          // order: explicit draftOrder ASC, then joinedAt ASC as the
          // tiebreaker for legacy rows that share order 0.
          members: {
            include: { player: true },
            orderBy: [{ draftOrder: "asc" }, { joinedAt: "asc" }],
          },
          matches: { where: { status: "CONFIRMED", format: "LEAGUE_BO2" } },
        },
      },
      matchConfigPreset: true,
    },
  });
}

// Per-player context for the draft editor — current league rank
// (Player.rating), latest BMP MMR snapshot, and the most-recently-
// ENDED prior season's final global rank. Bundled separately from the
// raw season include so we don't fan out N+1 queries in the loader.
export interface AdminSeasonMemberContext {
  leagueRating: number | null;
  bmpMmr: number | null;
  bmpPeak: number | null; // all-time peak BMP MMR across snapshots
  bmpPeakSeason: string | null; // the BMP season they hit that peak in
  bmpTier: string | null;
  priorFinalGlobalRank: number | null;
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
        closedAt: true,
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
  const totalConfirmed = season.divisions.reduce((sum, d) => sum + d.matches.length, 0);
  // Schedule-aware: a locked (graph) schedule expects only its pre-created
  // matchups, so the X/Y counter can actually reach 100%.
  const activeByDivision = new Map(
    season.divisions.map((d) => [d.id, new Set(d.members.filter((m) => m.status === "ACTIVE").map((m) => m.playerId))]),
  );
  const expectedByDivision = await expectedMatchesBySeason(season.id, activeByDivision, season.scheduleLocked);
  const totalExpected = season.divisions.reduce((sum, d) => sum + (expectedByDivision.get(d.id) ?? 0), 0);
  const needsChannels = !signupRound && !season.endedAt;
  const channels = needsChannels && opts.guildId ? await opts.listGuildTextChannels(opts.guildId) : [];

  // Build per-member context (league rank, BMP MMR, prior season's
  // final global rank) in batched queries. Pages that don't render
  // the draft editor (ended / active seasons) still get the map —
  // it's cheap and keeps the return shape uniform.
  const memberContext = await buildAdminSeasonMemberContext(season);

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
    memberContext,
  };
}

// Batched per-player lookups for the draft editor: current league
// rank (Player.rating), latest BMP MMR snapshot (via the same
// season-preferring strategy as loadBuildSeasonPage), and most-
// recently-ENDED prior season's finalGlobalRank.
async function buildAdminSeasonMemberContext(season: {
  id: string;
  startedAt: Date;
  divisions: Array<{ members: Array<{ playerId: string; player: { id: string; discordId: string; rating: number | null } }> }>;
}): Promise<Map<string, AdminSeasonMemberContext>> {
  const playerIds = season.divisions.flatMap((d) => d.members.map((m) => m.playerId));
  if (playerIds.length === 0) return new Map();
  const discordIds = season.divisions.flatMap((d) => d.members.map((m) => m.player.discordId));

  // Latest BMP MMR snapshot per discordId. Same season-preferring
  // logic as loadBuildSeasonPage: numeric bmpSeason DESC then
  // capturedAt DESC.
  const snapshots = await prisma.playerMmrSnapshot.findMany({
    where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
    select: { discordId: true, bmpSeason: true, rankedMmr: true, peakMmr: true, rankedTier: true, capturedAt: true },
  });
  const snapsByDiscord = new Map<string, typeof snapshots>();
  for (const s of snapshots) {
    const arr = snapsByDiscord.get(s.discordId) ?? [];
    arr.push(s);
    snapsByDiscord.set(s.discordId, arr);
  }
  for (const arr of snapsByDiscord.values()) {
    arr.sort(byBestBmpSnapshot);
  }

  // Prior-season finalGlobalRank — most recent ended season the
  // player was a member of whose endedAt < this season's startedAt.
  // Excludes the current season explicitly (would be null during
  // draft anyway; we want their last completed standing).
  const priorMemberships = await prisma.divisionMember.findMany({
    where: {
      playerId: { in: playerIds },
      finalGlobalRank: { not: null },
      division: {
        season: {
          endedAt: { not: null, lt: season.startedAt },
          NOT: { id: season.id },
        },
      },
    },
    select: {
      playerId: true,
      finalGlobalRank: true,
      division: { select: { season: { select: { endedAt: true } } } },
    },
  });
  // Reduce to one most-recently-ended membership per player.
  const priorByPlayerId = new Map<string, { endedAt: Date; finalGlobalRank: number }>();
  for (const m of priorMemberships) {
    if (m.finalGlobalRank == null) continue;
    const endedAt = m.division.season.endedAt;
    if (!endedAt) continue;
    const cur = priorByPlayerId.get(m.playerId);
    if (!cur || endedAt > cur.endedAt) {
      priorByPlayerId.set(m.playerId, { endedAt, finalGlobalRank: m.finalGlobalRank });
    }
  }

  const result = new Map<string, AdminSeasonMemberContext>();
  for (const d of season.divisions) {
    for (const m of d.members) {
      const snaps = snapsByDiscord.get(m.player.discordId) ?? [];
      const snap = snaps[0];
      // All-time peak = max peakMmr across all this player's snapshots; remember
      // which BMP season that peak was from.
      let bmpPeak: number | null = null;
      let bmpPeakSeason: string | null = null;
      for (const s of snaps) {
        if (s.peakMmr != null && (bmpPeak == null || s.peakMmr > bmpPeak)) {
          bmpPeak = s.peakMmr;
          bmpPeakSeason = s.bmpSeason;
        }
      }
      result.set(m.playerId, {
        leagueRating: m.player.rating,
        bmpMmr: snap?.rankedMmr ?? null,
        bmpPeak,
        bmpPeakSeason,
        bmpTier: snap?.rankedTier ?? null,
        priorFinalGlobalRank: priorByPlayerId.get(m.playerId)?.finalGlobalRank ?? null,
      });
    }
  }
  return result;
}

// ── /admin/seasons (index) ───────────────────────────────────────────

export type AdminSeasonsRound = {
  id: string;
  status: "OPEN" | "CLOSED" | "BUILT";
  closedAt: Date | null;
  channelId: string;
  resultingSeasonId: string | null;
  _count: { signups: number };
  // Active (non-withdrawn) roster, earliest first — so admins can see who's
  // actually in while a round is still open, without opening the build flow.
  signups: { displayName: string; globalName: string | null; discordId: string; inGuild: boolean | null; signedUpAt: Date }[];
};

// Signup rounds that exist without a linked Season yet — created via
// seed scripts (seed-test-league, seed-returners-from), or manually
// via earlier flows that didn't tie to a season. Surfaced on
// /admin/seasons so admin can see + build them without having to
// know the URL.
export interface OrphanSignupRound {
  id: string;
  name: string;
  status: "OPEN" | "CLOSED" | "BUILT";
  signupCount: number;
  closedAt: Date | null;
}

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
  // Buildable rounds with no resultingSeasonId yet. Empty when none
  // exist — page conditionally renders the section.
  orphanRounds: OrphanSignupRound[];
  channels: Array<{ id: string; name: string }>;
  archivedCount: number;
  /** Configured default signups channel (LeagueConfig.signups_channel_id) — pre-selects the Open-signups picker. */
  signupsDefaultChannelId: string | null;
}

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
          _count: { select: { members: true, matches: { where: { format: "LEAGUE_BO2" } } } },
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
  const [seasons, templatesRaw, lastUsed, presets, defaultPreset, signupRounds, archivedCount, orphanRoundsRaw, signupsConfig] =
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
          closedAt: true,
          channelId: true,
          resultingSeasonId: true,
          // Active (non-withdrawn) only, matching the public embed's count and
          // the roster list below — so "N joined" and the names agree.
          _count: { select: { signups: { where: { withdrawn: false } } } },
          signups: {
            where: { withdrawn: false },
            select: { displayName: true, globalName: true, discordId: true, inGuild: true, signedUpAt: true },
            orderBy: { signedUpAt: "asc" },
          },
        },
      }),
      prisma.season.count({ where: { archivedAt: { not: null } } }),
      // Orphan rounds: no resultingSeasonId, NOT yet built. Includes
      // OPEN (sitting in Discord with the button live) AND CLOSED
      // (admin closed them but never clicked Build). Excludes BUILT
      // because at that point a Season exists; the round is already
      // tied. Seed scripts create CLOSED orphans for testing the
      // build flow without a real signup channel.
      prisma.signupRound.findMany({
        where: { resultingSeasonId: null, status: { in: ["OPEN", "CLOSED"] } },
        select: {
          id: true,
          name: true,
          status: true,
          closedAt: true,
          _count: { select: { signups: { where: { withdrawn: false } } } },
        },
        orderBy: { openedAt: "desc" },
      }),
      prisma.leagueConfig.findUnique({
        where: { key: "signups_channel_id" },
        select: { value: true },
      }),
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
  const orphanRounds: OrphanSignupRound[] = orphanRoundsRaw.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    signupCount: r._count.signups,
    closedAt: r.closedAt,
  }));

  return {
    seasons,
    templates,
    initialTierConfig,
    presets,
    defaultPreset,
    roundsBySeason,
    orphanRounds,
    channels,
    archivedCount,
    signupsDefaultChannelId: signupsConfig?.value ?? null,
  };
}
