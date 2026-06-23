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

// Pure computation: replay games and return every player's resulting MMR. No
// writes. The two seed sources mean genuinely different (but each idempotent)
// things:
//   • "current" → INCREMENTAL. Seed from each player's current hiddenMmr (carry
//     volatility forward) and replay only games NOT yet applied (mmrApplied=false).
//     Re-running can't double-count — a second pass finds nothing to apply.
//   • "bmp" → FULL COLD-START replay from a fixed anchor (BMP ×1.5, volatility
//     reset to 0). Replays the whole season regardless of the applied flag; same
//     input → same output, so re-running is also idempotent. This is the reset.
// `appliedMatchIds` is the set of matches this pass consumed (for the settle write).
async function computeSeasonMmr(
  seasonId: string,
  seedSource: MmrSeedSource,
): Promise<{
  rows: MmrPreviewRow[];
  matchCount: number;
  appliedMatchIds: string[];
  ledger: Array<{ id: string; beforeA: number; afterA: number; beforeB: number; afterB: number }>;
}> {
  const players = await prisma.player.findMany({
    select: { id: true, discordId: true, displayName: true, hiddenMmr: true, mmrVolatility: true },
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
  const seedVolByPlayer = new Map<string, number>();
  for (const p of players) {
    const peak = peakByDiscord.get(p.discordId);
    const bmpSeed = peak ? Math.round(peak * 1.5) : DEFAULT_SEED;
    if (seedSource === "current") {
      seedByPlayer.set(p.id, p.hiddenMmr ?? bmpSeed);
      seedVolByPlayer.set(p.id, p.mmrVolatility); // carry volatility (incremental)
    } else {
      seedByPlayer.set(p.id, bmpSeed);
      seedVolByPlayer.set(p.id, 0); // fresh provisional swing (cold start)
    }
  }

  const matches = await prisma.match.findMany({
    where: {
      status: "CONFIRMED",
      format: "LEAGUE_BO2",
      division: { seasonId },
      // Incremental "current" only touches not-yet-applied games — that's what
      // makes re-running safe. "bmp" replays everything from scratch.
      ...(seedSource === "current" ? { mmrApplied: false } : {}),
    },
    orderBy: { confirmedAt: "asc" },
    select: { id: true, playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });

  const state = new Map<string, { mmr: number; vol: number; games: number }>();
  const get = (pid: string) =>
    state.get(pid) ?? { mmr: seedByPlayer.get(pid) ?? DEFAULT_SEED, vol: seedVolByPlayer.get(pid) ?? 0, games: 0 };

  const appliedMatchIds: string[] = [];
  const ledger: Array<{ id: string; beforeA: number; afterA: number; beforeB: number; afterB: number }> = [];
  for (const m of matches) {
    appliedMatchIds.push(m.id); // consumed regardless of outcome (draws settle too)
    const beforeA = get(m.playerAId).mmr;
    const beforeB = get(m.playerBId).mmr;
    // Derive the winner from the score whenever it's decisive — the Discord
    // confirm path never writes winnerId. Equal scores (1-1 / 0-0) → no winner.
    let winnerId = m.winnerId ?? null;
    if (!winnerId && m.gamesWonA !== m.gamesWonB) {
      winnerId = m.gamesWonA > m.gamesWonB ? m.playerAId : m.playerBId;
    }
    if (winnerId) {
      const loserId = winnerId === m.playerAId ? m.playerBId : m.playerAId;
      const w = get(winnerId);
      const l = get(loserId);
      const r = elowen1v1({ mmr: w.mmr, volatility: w.vol }, { mmr: l.mmr, volatility: l.vol });
      state.set(winnerId, { mmr: r.winner.mmr, vol: r.winner.volatility, games: w.games + 1 });
      state.set(loserId, { mmr: r.loser.mmr, vol: r.loser.volatility, games: l.games + 1 });
    }
    const afterA = state.get(m.playerAId)?.mmr ?? beforeA;
    const afterB = state.get(m.playerBId)?.mmr ?? beforeB;
    ledger.push({
      id: m.id,
      beforeA: Math.round(beforeA),
      afterA: Math.round(afterA),
      beforeB: Math.round(beforeB),
      afterB: Math.round(afterB),
    });
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
      volatility: s?.vol ?? seedVolByPlayer.get(p.id) ?? 0,
    };
  });
  return { rows, matchCount: matches.length, appliedMatchIds, ledger };
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

// Recovery helper: un-settle every confirmed game in a season (mmrApplied=false)
// so they can be re-applied from scratch. Does NOT touch anyone's MMR — only the
// applied flags. Use after restoring/re-entering seeds, to then apply the season
// once cleanly on top with the "Current MMR" (incremental) option.
export async function resetSeasonMmrApplication(seasonId?: string): Promise<{ reset: number; seasonId: string | null }> {
  const season = await resolveSeason(seasonId);
  if (!season) return { reset: 0, seasonId: null };
  const res = await prisma.match.updateMany({
    where: { status: "CONFIRMED", format: "LEAGUE_BO2", division: { seasonId: season.id } },
    data: { mmrApplied: false },
  });
  return { reset: res.count, seasonId: season.id };
}

// Apply — run the same computation and commit it, idempotently. Writes each
// player's hiddenMmr + volatility, then settles the matches this pass consumed:
//   • "current" → only the games it just applied (so future games stay live).
//   • "bmp" → every confirmed BO2 across all seasons, since a cold start accounts
//     for the whole history; past seasons are ignored by live anyway.
// Re-running is safe either way: "current" finds no unapplied games the second
// time (a true no-op); "bmp" recomputes the same deterministic result.
export async function applySeasonMmr(opts: { seasonId?: string; seedSource: MmrSeedSource }): Promise<{ updated: number; applied: number; seasonId: string | null }> {
  const season = await resolveSeason(opts.seasonId);
  if (!season) return { updated: 0, applied: 0, seasonId: null };
  const { rows, appliedMatchIds, ledger } = await computeSeasonMmr(season.id, opts.seedSource);
  await prisma.$transaction([
    ...rows.map((r) =>
      prisma.player.update({ where: { id: r.playerId }, data: { hiddenMmr: r.final, mmrVolatility: r.volatility } }),
    ),
    // Per-match MMR ledger (before/after for both sides).
    ...ledger.map((e) =>
      prisma.match.update({
        where: { id: e.id },
        data: { mmrBeforeA: e.beforeA, mmrAfterA: e.afterA, mmrBeforeB: e.beforeB, mmrAfterB: e.afterB },
      }),
    ),
    opts.seedSource === "bmp"
      ? prisma.match.updateMany({
          where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
          data: { mmrApplied: true },
        })
      : prisma.match.updateMany({
          where: { id: { in: appliedMatchIds } },
          data: { mmrApplied: true },
        }),
  ]);
  return { updated: rows.length, applied: appliedMatchIds.length, seasonId: season.id };
}
