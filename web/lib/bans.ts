import "server-only";

// League ban helpers (web side). Mirrors src/bans.ts — a banned Player can't sign
// up, be added to a round, opt into reminders, or be placed into a division.
//
// A ban is PERMANENT (banLiftsAtSeasonNumber = null) or a season-count TEMP ban
// (lifts once the next season number reaches banLiftsAtSeasonNumber).

import { prisma } from "@/lib/prisma";

export const BANNED_PLAYER_MESSAGE =
  "This player is banned from the league — unban them first (/admin/bans) if you want to include them.";
export const BANNED_SELF_MESSAGE =
  "You're banned from the league, so you can't sign up right now. If you think this is a mistake, reach out to a league moderator.";

export interface BanFields {
  bannedAt: Date | null;
  banLiftsAtSeasonNumber: number | null;
}

// The number a newly-built season would get (highest existing + 1).
export async function nextSeasonNumber(): Promise<number> {
  const s = await prisma.season.findFirst({ orderBy: { number: "desc" }, select: { number: true } });
  return (s?.number ?? 0) + 1;
}

export function isActiveBan(p: BanFields, nextSeason: number): boolean {
  if (p.bannedAt == null) return false;
  if (p.banLiftsAtSeasonNumber == null) return true; // permanent
  return nextSeason < p.banLiftsAtSeasonNumber; // temp ban not yet lifted
}

export async function isDiscordIdBanned(discordId: string): Promise<boolean> {
  const [p, next] = await Promise.all([
    prisma.player.findUnique({ where: { discordId }, select: { bannedAt: true, banLiftsAtSeasonNumber: true } }),
    nextSeasonNumber(),
  ]);
  return p ? isActiveBan(p, next) : false;
}

export async function isPlayerIdBanned(playerId: string): Promise<boolean> {
  const [p, next] = await Promise.all([
    prisma.player.findUnique({ where: { id: playerId }, select: { bannedAt: true, banLiftsAtSeasonNumber: true } }),
    nextSeasonNumber(),
  ]);
  return p ? isActiveBan(p, next) : false;
}

// Actively-banned subset of a list of Discord ids (filtering signup audiences).
export async function bannedDiscordIdSet(discordIds: string[]): Promise<Set<string>> {
  if (discordIds.length === 0) return new Set();
  const [rows, next] = await Promise.all([
    prisma.player.findMany({
      where: { discordId: { in: discordIds }, bannedAt: { not: null } },
      select: { discordId: true, bannedAt: true, banLiftsAtSeasonNumber: true },
    }),
    nextSeasonNumber(),
  ]);
  return new Set(rows.filter((r) => isActiveBan(r, next)).map((r) => r.discordId));
}

// Actively-banned subset of a list of Player ids (filtering placement inputs).
export async function bannedPlayerIdSet(playerIds: string[]): Promise<Set<string>> {
  if (playerIds.length === 0) return new Set();
  const [rows, next] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: playerIds }, bannedAt: { not: null } },
      select: { id: true, bannedAt: true, banLiftsAtSeasonNumber: true },
    }),
    nextSeasonNumber(),
  ]);
  return new Set(rows.filter((r) => isActiveBan(r, next)).map((r) => r.id));
}
