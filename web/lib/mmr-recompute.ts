import "server-only";

// Recompute hidden MMR from match history, as a configure → preview → apply
// flow. You choose:
//   • which SEASON's games to replay (default: the active season — hidden MMR is
//     a per-season-fresh estimate, so past seasons must not bleed in), and
//   • the STARTING point each player is seeded from: their current hidden MMR
//     (keep the seeds/ladder you set), or a BMP ×1.5 cold start (data-driven
//     from their Balatro skill).
// Then it replays that season's confirmed BO2s in chronological order through
// Elowen. `previewSeasonMmr` computes the result and writes nothing; `applySeasonMmr`
// runs the same computation and commits it.

import { prisma } from "@/lib/prisma";
import { elowen1v1 } from "@/lib/elowen";
import { formatSeasonLabel } from "@/lib/format-season";

// No BMP data → start at the base (BMP starts everyone at 200; ×1.5 onto the
// league scale = 300). A true unknown begins at the bottom, like a fresh account,
// and climbs from results — or gets hand-set.
const DEFAULT_SEED = 300;

// Where each player's MMR starts before this season's games are replayed.
//   current → their current hiddenMmr (preserves placement/ladder seeds)
//   bmp     → BMP peak ×1.5 cold start (ignores any seeding)
export type MmrSeedSource = "current" | "bmp";

export interface MmrPreviewRow {
  playerId: string;
  displayName: string;
  seed: number; // starting MMR
  final: number; // MMR after replaying the season
  delta: number; // final − seed
  games: number; // decided games that moved their MMR
  volatility: number;
}

export interface MmrPreview {
  rows: MmrPreviewRow[]; // sorted strongest-first
  seasonId: string | null;
  seasonLabel: string | null;
  seedSource: MmrSeedSource;
  matchCount: number; // confirmed BO2s in scope
}

// Resolve the target season (explicit id, else the active one).
async function resolveSeason(seasonId?: string) {
  if (seasonId) {
    return prisma.season.findUnique({ where: { id: seasonId }, select: { id: true, number: true, subtitle: true } });
  }
  return prisma.season.findFirst({ where: { isActive: true }, select: { id: true, number: true, subtitle: true } });
}

// Pure computation: replay one season's games from the chosen seed and return
// every player's resulting MMR. No writes. Volatility starts fresh (0) for the
// replay so the season's early games carry their provisional swing.
async function computeSeasonMmr(
  seasonId: string,
  seedSource: MmrSeedSource,
): Promise<{ rows: MmrPreviewRow[]; matchCount: number }> {
  const players = await prisma.player.findMany({
    select: { id: true, discordId: true, displayName: true, hiddenMmr: true },
  });
  const discordIds = players.map((p) => p.discordId);
  const snaps = discordIds.length
    ? await prisma.playerMmrSnapshot.findMany({
        where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
        orderBy: { capturedAt: "desc" },
        distinct: ["discordId"],
        select: { discordId: true, peakMmr: true, rankedMmr: true },
      })
    : [];
  const peakByDiscord = new Map(snaps.map((s) => [s.discordId, s.peakMmr ?? s.rankedMmr ?? null]));

  const seedByPlayer = new Map<string, number>();
  for (const p of players) {
    const peak = peakByDiscord.get(p.discordId);
    const bmpSeed = peak ? Math.round(peak * 1.5) : DEFAULT_SEED;
    seedByPlayer.set(p.id, seedSource === "current" ? (p.hiddenMmr ?? bmpSeed) : bmpSeed);
  }

  const matches = await prisma.match.findMany({
    where: { status: "CONFIRMED", format: "LEAGUE_BO2", division: { seasonId } },
    orderBy: { confirmedAt: "asc" },
    select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });

  const state = new Map<string, { mmr: number; vol: number; games: number }>();
  const get = (pid: string) => state.get(pid) ?? { mmr: seedByPlayer.get(pid) ?? DEFAULT_SEED, vol: 0, games: 0 };

  for (const m of matches) {
    // Derive the winner from the score whenever it's decisive — the Discord
    // confirm path never writes winnerId. Equal scores (1-1 / 0-0) → no winner.
    let winnerId = m.winnerId ?? null;
    if (!winnerId && m.gamesWonA !== m.gamesWonB) {
      winnerId = m.gamesWonA > m.gamesWonB ? m.playerAId : m.playerBId;
    }
    if (!winnerId) continue;
    const loserId = winnerId === m.playerAId ? m.playerBId : m.playerAId;
    const w = get(winnerId);
    const l = get(loserId);
    const r = elowen1v1({ mmr: w.mmr, volatility: w.vol }, { mmr: l.mmr, volatility: l.vol });
    state.set(winnerId, { mmr: r.winner.mmr, vol: r.winner.volatility, games: w.games + 1 });
    state.set(loserId, { mmr: r.loser.mmr, vol: r.loser.volatility, games: l.games + 1 });
  }

  const rows: MmrPreviewRow[] = players.map((p) => {
    const seed = Math.round(seedByPlayer.get(p.id) ?? DEFAULT_SEED);
    const s = state.get(p.id);
    const final = s ? Math.round(s.mmr) : seed;
    return {
      playerId: p.id,
      displayName: p.displayName,
      seed,
      final,
      delta: final - seed,
      games: s?.games ?? 0,
      volatility: s?.vol ?? 0,
    };
  });
  return { rows, matchCount: matches.length };
}

// Preview only — compute and return, write nothing.
export async function previewSeasonMmr(opts: { seasonId?: string; seedSource: MmrSeedSource }): Promise<MmrPreview> {
  const season = await resolveSeason(opts.seasonId);
  if (!season) {
    return { rows: [], seasonId: null, seasonLabel: null, seedSource: opts.seedSource, matchCount: 0 };
  }
  const { rows, matchCount } = await computeSeasonMmr(season.id, opts.seedSource);
  rows.sort((a, b) => b.final - a.final || a.displayName.localeCompare(b.displayName));
  return { rows, seasonId: season.id, seasonLabel: formatSeasonLabel(season), seedSource: opts.seedSource, matchCount };
}

// Apply — run the same computation and commit it. Writes each player's hiddenMmr
// + volatility, and flags EVERY confirmed BO2 as mmrApplied so live MMR (once on)
// continues cleanly from here without re-applying this season or any past one.
export async function applySeasonMmr(opts: { seasonId?: string; seedSource: MmrSeedSource }): Promise<{ updated: number; seasonId: string | null }> {
  const season = await resolveSeason(opts.seasonId);
  if (!season) return { updated: 0, seasonId: null };
  const { rows } = await computeSeasonMmr(season.id, opts.seedSource);
  await prisma.$transaction([
    ...rows.map((r) =>
      prisma.player.update({ where: { id: r.playerId }, data: { hiddenMmr: r.final, mmrVolatility: r.volatility } }),
    ),
    prisma.match.updateMany({
      where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
      data: { mmrApplied: true },
    }),
  ]);
  return { updated: rows.length, seasonId: season.id };
}
