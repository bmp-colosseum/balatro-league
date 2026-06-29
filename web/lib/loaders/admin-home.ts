// Admin home/dashboard + page-nav loaders. Each function backs one
// /admin/* page; relocated verbatim from admin.ts (no behavior change).
//
// Conventions:
//   - All admin loaders assume requireAdmin() ran in the page
//   - Return shapes are page-specific; never expose raw Prisma types
//     to the caller (so the schema can evolve without touching pages)

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

const MOCK_PREFIXES = ["mock", "sim"]; // dashless; startsWith still matches legacy "mock-"/"sim-"
function isMockId(id: string) {
  return MOCK_PREFIXES.some((p) => id.startsWith(p));
}

// ── /admin/disputes ──────────────────────────────────────────────────

export interface AdminDisputeRow {
  pairingId: string;
  divisionId: string;
  divisionName: string;
  tierName: string;
  playerA: { id: string; displayName: string; discordId: string; username: string | null };
  playerB: { id: string; displayName: string; discordId: string; username: string | null };
  gamesWonA: number;
  gamesWonB: number;
  disputedAt: Date | null;
  disputer: { id: string; displayName: string; discordId: string; username: string | null } | null;
  reporter: { id: string; displayName: string; discordId: string; username: string | null } | null;
  disputeProposedGamesWonA: number | null;
  disputeProposedGamesWonB: number | null;
  disputeProposedLivesG1: number | null;
  disputeProposedLivesG2: number | null;
  disputeReason: string | null;
  disputeThreadId: string | null;
}

export async function loadAdminDisputes(): Promise<AdminDisputeRow[]> {
  const rows = await prisma.match.findMany({
    where: { status: "DISPUTED", format: "LEAGUE_BO2", division: { season: { isActive: true } } },
    select: {
      id: true,
      divisionId: true,
      gamesWonA: true,
      gamesWonB: true,
      disputedAt: true,
      disputeProposedGamesWonA: true,
      disputeProposedGamesWonB: true,
      disputeProposedLivesG1: true,
      disputeProposedLivesG2: true,
      disputeReason: true,
      disputeThreadId: true,
      playerA: { select: { id: true, displayName: true, discordId: true, username: true } },
      playerB: { select: { id: true, displayName: true, discordId: true, username: true } },
      disputer: { select: { id: true, displayName: true, discordId: true, username: true } },
      reporter: { select: { id: true, displayName: true, discordId: true, username: true } },
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
    disputeProposedLivesG1: r.disputeProposedLivesG1,
    disputeProposedLivesG2: r.disputeProposedLivesG2,
    disputeReason: r.disputeReason,
    disputeThreadId: r.disputeThreadId,
  }));
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
      select: { id: true, number: true, subtitle: true, _count: { select: { divisions: true } } },
    }),
    prisma.player.count(),
    prisma.player.findMany({ select: { discordId: true } }),
    prisma.match.count({ where: { status: "CONFIRMED", format: "LEAGUE_BO2" } }),
    prisma.match.count({ where: { status: "DISPUTED", format: "LEAGUE_BO2" } }),
  ]);
  return {
    activeSeason: activeSeason
      ? { id: activeSeason.id, name: formatSeasonLabel(activeSeason), divisionCount: activeSeason._count.divisions }
      : null,
    totalPlayers,
    fakePlayerCount: allDiscordIds.filter((p) => isMockId(p.discordId)).length,
    confirmedPairings: confirmed,
    disputedPairings: disputed,
  };
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
  // Which preset id (if any) is currently pointed to by each role key.
  // Either may be null on a fresh install before bootstrap has run.
  seasonDefaultPresetId: string | null;
  casualPresetId: string | null;
  customComboPresetId: string | null;
}

export async function loadDeckBansPage(selectedIdParam: string | undefined): Promise<DeckBansPageData> {
  const [rows, configRows] = await Promise.all([
    prisma.matchConfigPreset.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        decks: true,
        stakes: true,
        _count: { select: { seasons: true } },
      },
    }),
    prisma.leagueConfig.findMany({
      where: { key: { in: ["season_default_preset_id", "casual_preset_id", "custom_combo_preset_id"] } },
      select: { key: true, value: true },
    }),
  ]);
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
  const configByKey = new Map(configRows.map((r) => [r.key, r.value]));
  return {
    presets,
    selected,
    seasonDefaultPresetId: configByKey.get("season_default_preset_id") ?? null,
    casualPresetId: configByKey.get("casual_preset_id") ?? null,
    customComboPresetId: configByKey.get("custom_combo_preset_id") ?? null,
  };
}

