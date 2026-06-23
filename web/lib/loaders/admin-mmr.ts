// Loaders for the hidden-MMR admin page (/admin/mmr). Assumes
// requireAdmin() ran in the page.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

// Whether live MMR is enabled (the sweep auto-updates MMR on each confirmed
// match). Stored as the string "true" in LeagueConfig.
export async function loadLiveMmrEnabled(): Promise<boolean> {
  return (
    (await prisma.leagueConfig.findUnique({ where: { key: "live_mmr_enabled" } }))?.value === "true"
  );
}

export interface MmrStatus {
  seasonLabel: string | null;
  liveMmr: boolean;
  totalConfirmed: number; // confirmed BO2s this season
  applied: number; // ...that have been applied to MMR
  pending: number; // ...not yet applied
  playersWithMmr: number;
  totalPlayers: number;
  mmrMin: number | null;
  mmrMax: number | null;
}

// A plain "where do we stand" snapshot for the top of /admin/mmr: is live on,
// how many of this season's confirmed games have been applied to MMR, and the
// current spread. Answers "was MMR applied?" at a glance.
export async function loadMmrStatus(): Promise<MmrStatus> {
  const [season, liveCfg, players] = await Promise.all([
    prisma.season.findFirst({ where: { isActive: true }, select: { id: true, number: true, subtitle: true } }),
    prisma.leagueConfig.findUnique({ where: { key: "live_mmr_enabled" } }),
    prisma.player.findMany({ select: { hiddenMmr: true } }),
  ]);
  const liveMmr = liveCfg?.value === "true";
  const withMmr = players.filter((p) => p.hiddenMmr != null).map((p) => p.hiddenMmr!);
  const base = {
    seasonLabel: season ? formatSeasonLabel(season) : null,
    liveMmr,
    playersWithMmr: withMmr.length,
    totalPlayers: players.length,
    mmrMin: withMmr.length ? Math.min(...withMmr) : null,
    mmrMax: withMmr.length ? Math.max(...withMmr) : null,
  };
  if (!season) return { ...base, totalConfirmed: 0, applied: 0, pending: 0 };
  const [totalConfirmed, applied] = await Promise.all([
    prisma.match.count({ where: { status: "CONFIRMED", format: "LEAGUE_BO2", division: { seasonId: season.id } } }),
    prisma.match.count({ where: { status: "CONFIRMED", format: "LEAGUE_BO2", mmrApplied: true, division: { seasonId: season.id } } }),
  ]);
  return { ...base, totalConfirmed, applied, pending: totalConfirmed - applied };
}

export interface MmrSeasonOption {
  id: string;
  label: string;
  isActive: boolean;
}

// Seasons that have any games to recompute from, for the MMR basis picker.
// Active season first, then most recent. Archived seasons excluded.
export async function loadMmrSeasons(): Promise<MmrSeasonOption[]> {
  const seasons = await prisma.season.findMany({
    where: { archivedAt: null },
    orderBy: [{ isActive: "desc" }, { number: "desc" }],
    select: { id: true, number: true, subtitle: true, isActive: true },
  });
  return seasons.map((s) => ({ id: s.id, label: formatSeasonLabel(s), isActive: s.isActive }));
}
