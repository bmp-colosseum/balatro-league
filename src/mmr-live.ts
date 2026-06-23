// Hands-off live MMR: apply Elowen to every confirmed BO2 that hasn't been
// applied yet, in confirmed order. Run from the match-sweep, so it catches every
// confirm path (self-report auto-confirm, opponent confirm, admin record) with
// no double-apply (the mmrApplied flag). INCREMENTAL — it nudges each player's
// current hiddenMmr, so hand-tuned / seeded values are preserved (unlike the
// full /admin/mmr recompute, which re-seeds from BMP).

import { prisma } from "./db.js";
import { elowen1v1 } from "./elowen.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";

// No BMP data → base seed (BMP base 200 × 1.5 onto the league scale = 300).
const DEFAULT_SEED = 300;

export async function applyPendingMatchMmr(): Promise<number> {
  // Off by default — MMR stays preview-only until live MMR is explicitly enabled.
  if ((await getConfig(LeagueConfigKey.LiveMmrEnabled)) !== "true") return 0;

  // Active season only — hidden MMR is a per-season-fresh estimate, so past
  // seasons (e.g. Season 1) must never move it, even if their matches are still
  // flagged unapplied.
  const pending = await prisma.match.findMany({
    where: {
      status: "CONFIRMED",
      format: "LEAGUE_BO2",
      mmrApplied: false,
      division: { season: { isActive: true } },
    },
    orderBy: { confirmedAt: "asc" },
    select: { id: true, playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, winnerId: true },
  });
  if (pending.length === 0) return 0;

  const ids = [...new Set(pending.flatMap((m) => [m.playerAId, m.playerBId]))];
  const players = await prisma.player.findMany({
    where: { id: { in: ids } },
    select: { id: true, discordId: true, hiddenMmr: true, mmrVolatility: true },
  });
  const discordIds = players.map((p) => p.discordId);
  const snaps = await prisma.playerMmrSnapshot.findMany({
    where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
    orderBy: { capturedAt: "desc" },
    distinct: ["discordId"],
    select: { discordId: true, peakMmr: true, rankedMmr: true },
  });
  const peakByDiscord = new Map(snaps.map((s) => [s.discordId, s.peakMmr ?? s.rankedMmr ?? null]));

  // Start each player from their current MMR; if unset, seed from BMP ×1.5.
  const state = new Map<string, { mmr: number; vol: number }>();
  for (const p of players) {
    const peak = peakByDiscord.get(p.discordId);
    const seed = p.hiddenMmr ?? (peak ? Math.round(peak * 1.5) : DEFAULT_SEED);
    state.set(p.id, { mmr: seed, vol: p.mmrVolatility });
  }
  const get = (id: string) => state.get(id) ?? { mmr: DEFAULT_SEED, vol: 0 };

  const appliedIds: string[] = [];
  const ledger: Array<{ id: string; beforeA: number; afterA: number; beforeB: number; afterB: number }> = [];
  for (const m of pending) {
    const beforeA = get(m.playerAId).mmr;
    const beforeB = get(m.playerBId).mmr;
    // Derive the winner from the score whenever it's decisive — the Discord
    // confirm path never writes winnerId, so a 2-1 (or any non-2-0) result
    // would otherwise be dropped. Equal scores (1-1 draw, 0-0 void) → no winner.
    let winnerId = m.winnerId ?? null;
    if (!winnerId && m.gamesWonA !== m.gamesWonB) {
      winnerId = m.gamesWonA > m.gamesWonB ? m.playerAId : m.playerBId;
    }
    if (winnerId) {
      const loserId = winnerId === m.playerAId ? m.playerBId : m.playerAId;
      const w = get(winnerId);
      const l = get(loserId);
      const r = elowen1v1({ mmr: w.mmr, volatility: w.vol }, { mmr: l.mmr, volatility: l.vol });
      state.set(winnerId, { mmr: r.winner.mmr, vol: r.winner.volatility });
      state.set(loserId, { mmr: r.loser.mmr, vol: r.loser.volatility });
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
    appliedIds.push(m.id); // also flag draws (no change) so they aren't re-scanned
  }

  await prisma.$transaction([
    ...[...state.entries()].map(([id, s]) =>
      prisma.player.update({ where: { id }, data: { hiddenMmr: Math.round(s.mmr), mmrVolatility: s.vol } }),
    ),
    // Per-match MMR ledger (before/after for both sides).
    ...ledger.map((e) =>
      prisma.match.update({
        where: { id: e.id },
        data: { mmrBeforeA: e.beforeA, mmrAfterA: e.afterA, mmrBeforeB: e.beforeB, mmrAfterB: e.afterB },
      }),
    ),
    prisma.match.updateMany({ where: { id: { in: appliedIds } }, data: { mmrApplied: true } }),
  ]);

  return appliedIds.length;
}
