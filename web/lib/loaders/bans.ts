import "server-only";

import { prisma } from "@/lib/prisma";
import { isActiveBan, nextSeasonNumber } from "@/lib/bans";

export interface BannedPlayerRow {
  id: string;
  displayName: string;
  discordId: string;
  bannedAt: Date;
  bannedReason: string | null;
  bannedBy: string | null;
  banLiftsAtSeasonNumber: number | null;
  active: boolean; // ban currently in effect
  durationLabel: string; // "Permanent" | "through Season N" | "lifted (was …)"
  strikeCount: number;
}

export interface StrikeRow {
  id: string;
  reason: string;
  issuedByName: string;
  createdAt: Date;
}
export interface PlayerStrikes {
  playerId: string;
  displayName: string;
  discordId: string;
  banned: boolean;
  strikes: StrikeRow[];
}

export interface BansPageData {
  nextSeason: number;
  banned: BannedPlayerRow[];
  strikers: PlayerStrikes[];
}

function durationLabel(banLifts: number | null, active: boolean): string {
  if (banLifts == null) return "Permanent";
  const through = `Season ${banLifts - 1}`;
  return active ? `through ${through}` : `lifted (was through ${through})`;
}

export async function loadBansPage(): Promise<BansPageData> {
  const nextSeason = await nextSeasonNumber();

  const bannedRaw = await prisma.player.findMany({
    where: { bannedAt: { not: null } },
    select: {
      id: true,
      displayName: true,
      discordId: true,
      bannedAt: true,
      bannedReason: true,
      bannedBy: true,
      banLiftsAtSeasonNumber: true,
      _count: { select: { strikes: true } },
    },
    orderBy: { bannedAt: "desc" },
  });
  const banned: BannedPlayerRow[] = bannedRaw.map((r) => {
    const active = isActiveBan({ bannedAt: r.bannedAt, banLiftsAtSeasonNumber: r.banLiftsAtSeasonNumber }, nextSeason);
    return {
      id: r.id,
      displayName: r.displayName,
      discordId: r.discordId,
      bannedAt: r.bannedAt as Date,
      bannedReason: r.bannedReason,
      bannedBy: r.bannedBy,
      banLiftsAtSeasonNumber: r.banLiftsAtSeasonNumber,
      active,
      durationLabel: durationLabel(r.banLiftsAtSeasonNumber, active),
      strikeCount: r._count.strikes,
    };
  });

  // Everyone who has at least one strike, with their strikes (newest first).
  const strikeRows = await prisma.strike.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      reason: true,
      issuedByName: true,
      createdAt: true,
      player: { select: { id: true, displayName: true, discordId: true, bannedAt: true, banLiftsAtSeasonNumber: true } },
    },
  });
  const byPlayer = new Map<string, PlayerStrikes>();
  for (const s of strikeRows) {
    let entry = byPlayer.get(s.player.id);
    if (!entry) {
      entry = {
        playerId: s.player.id,
        displayName: s.player.displayName,
        discordId: s.player.discordId,
        banned: isActiveBan({ bannedAt: s.player.bannedAt, banLiftsAtSeasonNumber: s.player.banLiftsAtSeasonNumber }, nextSeason),
        strikes: [],
      };
      byPlayer.set(s.player.id, entry);
    }
    entry.strikes.push({ id: s.id, reason: s.reason, issuedByName: s.issuedByName, createdAt: s.createdAt });
  }
  // Most-struck first.
  const strikers = [...byPlayer.values()].sort((a, b) => b.strikes.length - a.strikes.length);

  return { nextSeason, banned, strikers };
}
