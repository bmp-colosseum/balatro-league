// League ban helpers. A banned Player (Player.bannedAt set) can't sign up, be
// added to a round, opt into reminders, be placed, or start/queue any match.
// One home for the checks so every gate behaves identically.
//
// A ban is PERMANENT (banLiftsAtSeasonNumber = null) or a season-count TEMP ban
// (banLiftsAtSeasonNumber = the season number at which it lifts). A temp ban is
// active while the NEXT season number is below that lift number — so it blocks
// the next N seasons and frees the one after.

import { prisma } from "./db.js";

// The player-facing message shown when a banned player tries to sign up or play.
export const BANNED_MESSAGE =
  "You're banned from the league, so you can't sign up or play right now. If you think this is a mistake, reach out to a league moderator.";

interface BanFields {
  bannedAt: Date | null;
  banLiftsAtSeasonNumber: number | null;
}

// The number a newly-built season would get (highest existing + 1). A season
// ban lifts once this reaches its lift number.
export async function nextSeasonNumber(): Promise<number> {
  const s = await prisma.season.findFirst({ orderBy: { number: "desc" }, select: { number: true } });
  return (s?.number ?? 0) + 1;
}

// Is this ban currently in effect, given the next season number?
export function isActiveBan(p: BanFields, nextSeason: number): boolean {
  if (p.bannedAt == null) return false;
  if (p.banLiftsAtSeasonNumber == null) return true; // permanent
  return nextSeason < p.banLiftsAtSeasonNumber; // temp ban not yet lifted
}

// Is the player with this Discord id currently banned? False if no Player row.
export async function isDiscordIdBanned(discordId: string): Promise<boolean> {
  const [p, next] = await Promise.all([
    prisma.player.findUnique({ where: { discordId }, select: { bannedAt: true, banLiftsAtSeasonNumber: true } }),
    nextSeasonNumber(),
  ]);
  return p ? isActiveBan(p, next) : false;
}

// Which of these Player ids are ACTIVELY banned — gate a pair (or list) at once.
export async function bannedPlayerIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [rows, next] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: ids }, bannedAt: { not: null } },
      select: { id: true, bannedAt: true, banLiftsAtSeasonNumber: true },
    }),
    nextSeasonNumber(),
  ]);
  return new Set(rows.filter((r) => isActiveBan(r, next)).map((r) => r.id));
}

// Which of these Discord ids are ACTIVELY banned — for the reminder audience.
export async function bannedDiscordIds(discordIds: string[]): Promise<Set<string>> {
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
