import "server-only";

// Recompute every player's hidden MMR from actual match history. Seed each from
// BMP peak ×1.5 (the cold start), then replay every confirmed BO2 in
// chronological order through Elowen. A player's real results pull them to their
// true level — so a strong league player with a weak BMP climbs off their wins,
// no hand-tuning needed. This is the data-driven path; manual edits on /admin/mmr
// are the override for anyone the data can't reach (e.g. no games + no BMP).

import { prisma } from "@/lib/prisma";
import { elowen1v1 } from "@/lib/elowen";

// No BMP data → start at the base (BMP starts everyone at 200; ×1.5 onto the
// league scale = 300). A true unknown begins at the bottom, like a fresh account,
// and climbs from results — or gets hand-set. Owen's call for newcomers the
// scrape can't reach is to ballpark them manually.
const DEFAULT_SEED = 300;

export interface RecomputeRow {
  playerId: string;
  displayName: string;
  seed: number;
  final: number;
  volatility: number;
  games: number;
}

export async function recomputeMmrFromHistory(): Promise<RecomputeRow[]> {
  const players = await prisma.player.findMany({ select: { id: true, discordId: true, displayName: true } });
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
    seedByPlayer.set(p.id, peak ? Math.round(peak * 1.5) : DEFAULT_SEED);
  }

  // Every confirmed BO2, oldest first, so Elowen sees results in order.
  const matches = await prisma.match.findMany({
    where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
    orderBy: { confirmedAt: "asc" },
    select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });

  const state = new Map<string, { mmr: number; vol: number; games: number }>();
  const get = (pid: string) => state.get(pid) ?? { mmr: seedByPlayer.get(pid) ?? DEFAULT_SEED, vol: 0, games: 0 };

  for (const m of matches) {
    // Derive the winner from the score whenever it's decisive — the Discord
    // confirm path never writes winnerId, so a 2-1 (or any non-2-0) result
    // would otherwise be dropped. Equal scores (1-1 draw, 0-0 void) → no winner.
    let winnerId = m.winnerId ?? null;
    if (!winnerId && m.gamesWonA !== m.gamesWonB) {
      winnerId = m.gamesWonA > m.gamesWonB ? m.playerAId : m.playerBId;
    }
    if (!winnerId) continue; // 1-1 draw / 0-0 void / indeterminate → no MMR change
    const loserId = winnerId === m.playerAId ? m.playerBId : m.playerAId;
    const w = get(winnerId);
    const l = get(loserId);
    const r = elowen1v1({ mmr: w.mmr, volatility: w.vol }, { mmr: l.mmr, volatility: l.vol });
    state.set(winnerId, { mmr: r.winner.mmr, vol: r.winner.volatility, games: w.games + 1 });
    state.set(loserId, { mmr: r.loser.mmr, vol: r.loser.volatility, games: l.games + 1 });
  }

  return players.map((p) => {
    const s = state.get(p.id);
    const seed = seedByPlayer.get(p.id) ?? DEFAULT_SEED;
    return {
      playerId: p.id,
      displayName: p.displayName,
      seed,
      final: s ? Math.round(s.mmr) : seed,
      volatility: s?.vol ?? 0,
      games: s?.games ?? 0,
    };
  });
}

export async function applyRecomputedMmr(): Promise<{ updated: number }> {
  const rows = await recomputeMmrFromHistory();
  await prisma.$transaction([
    ...rows.map((r) =>
      prisma.player.update({ where: { id: r.playerId }, data: { hiddenMmr: r.final, mmrVolatility: r.volatility } }),
    ),
    // The full replay already accounted for every confirmed match — flag them so
    // the live sweep doesn't apply them a second time.
    prisma.match.updateMany({
      where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
      data: { mmrApplied: true },
    }),
  ]);
  return { updated: rows.length };
}
