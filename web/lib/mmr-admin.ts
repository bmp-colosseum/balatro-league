import "server-only";

// Secret-MMR onboarding: seed each player's hiddenMmr from their BMP peak (×1.5,
// landing on the league scale, BMP peak ×1.5) and let admin hand-tweak. Owen's "go
// through and give out MMRs once" step. The loader + the two mutations the
// /admin/mmr screen drives.

import { prisma } from "@/lib/prisma";

// 1.5× peak BMP → league scale (Owen's conversion). Rounds to a whole MMR.
export function bmpToLeagueMmr(peak: number): number {
  return Math.round(peak * 1.5);
}

export interface MmrAdminRow {
  id: string;
  displayName: string;
  hiddenMmr: number | null;
  bmpPeak: number | null;
  bmpTier: string | null;
  suggested: number | null; // 1.5× peak, the seed value
}

export async function loadMmrAdmin(): Promise<MmrAdminRow[]> {
  const players = await prisma.player.findMany({
    select: { id: true, displayName: true, discordId: true, hiddenMmr: true },
  });
  const discordIds = players.map((p) => p.discordId);
  // ALL snapshots (every BMP season) — peak is per-season, so all-time peak =
  // max peakMmr across them. Latest snapshot gives the current tier.
  const allSnaps = discordIds.length
    ? await prisma.playerMmrSnapshot.findMany({
        where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
        orderBy: { capturedAt: "desc" },
        select: { discordId: true, peakMmr: true, rankedMmr: true, rankedTier: true },
      })
    : [];
  const latestTier = new Map<string, string | null>();
  const peakByDiscord = new Map<string, number>();
  for (const s of allSnaps) {
    if (!latestTier.has(s.discordId)) latestTier.set(s.discordId, s.rankedTier ?? null);
    const prev = peakByDiscord.get(s.discordId) ?? 0;
    const cand = Math.max(s.peakMmr ?? 0, s.rankedMmr ?? 0);
    if (cand > prev) peakByDiscord.set(s.discordId, cand);
  }

  const rows: MmrAdminRow[] = players.map((p) => {
    const peak = peakByDiscord.get(p.discordId) ?? null;
    return {
      id: p.id,
      displayName: p.displayName,
      hiddenMmr: p.hiddenMmr,
      bmpPeak: peak,
      bmpTier: latestTier.get(p.discordId) ?? null,
      suggested: peak != null ? bmpToLeagueMmr(peak) : null,
    };
  });

  // Set MMRs first (desc), unset last; then by name.
  rows.sort((a, b) => {
    if ((a.hiddenMmr == null) !== (b.hiddenMmr == null)) return a.hiddenMmr == null ? 1 : -1;
    if (a.hiddenMmr != null && b.hiddenMmr != null && a.hiddenMmr !== b.hiddenMmr) return b.hiddenMmr - a.hiddenMmr;
    return a.displayName.localeCompare(b.displayName);
  });
  return rows;
}

// Fill hiddenMmr from BMP for players who don't have one yet. Only fills NULLs —
// never overwrites a value someone set by hand (Owen's "set once").
export async function seedMissingMmrFromBmp(): Promise<{ filled: number; skipped: number }> {
  const players = await prisma.player.findMany({
    where: { hiddenMmr: null },
    select: { id: true, discordId: true },
  });
  if (players.length === 0) return { filled: 0, skipped: 0 };
  const discordIds = players.map((p) => p.discordId);
  const snaps = await prisma.playerMmrSnapshot.findMany({
    where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
    orderBy: { capturedAt: "desc" },
    distinct: ["discordId"],
    select: { discordId: true, peakMmr: true, rankedMmr: true },
  });
  const peakByDiscord = new Map(snaps.map((s) => [s.discordId, s.peakMmr ?? s.rankedMmr ?? null]));

  let filled = 0;
  let skipped = 0;
  for (const p of players) {
    const peak = peakByDiscord.get(p.discordId);
    if (peak == null) { skipped++; continue; }
    await prisma.player.update({ where: { id: p.id }, data: { hiddenMmr: bmpToLeagueMmr(peak) } });
    filled++;
  }
  return { filled, skipped };
}

export async function setPlayerMmr(playerId: string, mmr: number | null): Promise<void> {
  await prisma.player.update({ where: { id: playerId }, data: { hiddenMmr: mmr } });
}
