// Strikes — reliability/conduct marks. Per the rules these are TO-discretion AIDS:
// they track + surface patterns, they never auto-penalize. Career-spanning (each
// strike optionally tied to a season) with per-season + career counts. TO-issued.
import { prisma } from "../db";

export const AT_RISK_THRESHOLD = 3; // informational "⚠ at risk" flag, not a penalty
export const STRIKE_KINDS = ["SCHEDULING", "NO_SHOW", "CONDUCT", "OTHER"] as const;
export type StrikeKind = (typeof STRIKE_KINDS)[number];
export const STRIKE_LABEL: Record<string, string> = {
  SCHEDULING: "Scheduling",
  NO_SHOW: "No-show",
  CONDUCT: "Conduct",
  OTHER: "Other",
};

export async function addStrike(playerId: string, seasonName: string | null, week: number | null, kind: string, reason: string, by?: string) {
  if (!playerId) throw new Error("Pick a player.");
  if (!reason.trim()) throw new Error("A reason is required.");
  let seasonId: string | null = null;
  if (seasonName) {
    const s = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
    seasonId = s?.id ?? null;
  }
  await prisma.strike.create({
    data: { playerId, seasonId, week: week && week > 0 ? week : null, kind: (STRIKE_KINDS as readonly string[]).includes(kind) ? (kind as StrikeKind) : "OTHER", reason: reason.trim(), issuedBy: by },
  });
}

export async function removeStrike(id: string) {
  await prisma.strike.delete({ where: { id } });
}

// One player's full strike history (career), with per-season counts + the list.
export async function getPlayerStrikes(playerId: string) {
  const strikes = await prisma.strike.findMany({ where: { playerId }, orderBy: { createdAt: "desc" } });
  const sids = [...new Set(strikes.map((s) => s.seasonId).filter((x): x is string => !!x))];
  const seasons = await prisma.tourSeason.findMany({ where: { id: { in: sids } }, select: { id: true, name: true } });
  const nameOf = new Map(seasons.map((s) => [s.id, s.name]));
  const bySeason = new Map<string, number>();
  for (const s of strikes) {
    const k = s.seasonId ? nameOf.get(s.seasonId) ?? "?" : "(general)";
    bySeason.set(k, (bySeason.get(k) ?? 0) + 1);
  }
  return {
    total: strikes.length,
    atRisk: strikes.length >= AT_RISK_THRESHOLD,
    bySeason: [...bySeason.entries()].map(([season, count]) => ({ season, count })),
    list: strikes.map((s) => ({
      id: s.id,
      kind: s.kind,
      kindLabel: STRIKE_LABEL[s.kind] ?? s.kind,
      reason: s.reason,
      week: s.week,
      season: s.seasonId ? nameOf.get(s.seasonId) ?? null : null,
      issuedBy: s.issuedBy,
      createdAt: s.createdAt,
    })),
  };
}

// playerId → count for a season (TO roster view).
export async function getSeasonStrikeCounts(seasonId: string): Promise<Map<string, number>> {
  const strikes = await prisma.strike.findMany({ where: { seasonId }, select: { playerId: true } });
  const m = new Map<string, number>();
  for (const x of strikes) m.set(x.playerId, (m.get(x.playerId) ?? 0) + 1);
  return m;
}

// playerId → career count across all seasons (for the given players).
export async function getCareerStrikeCounts(playerIds: string[]): Promise<Map<string, number>> {
  const strikes = await prisma.strike.findMany({ where: { playerId: { in: playerIds } }, select: { playerId: true } });
  const m = new Map<string, number>();
  for (const x of strikes) m.set(x.playerId, (m.get(x.playerId) ?? 0) + 1);
  return m;
}

// The season's strike log (newest first) with player names — for the TO panel.
export async function getSeasonStrikeLog(seasonId: string) {
  const strikes = await prisma.strike.findMany({ where: { seasonId }, orderBy: { createdAt: "desc" } });
  const pids = [...new Set(strikes.map((s) => s.playerId))];
  const players = await prisma.player.findMany({ where: { id: { in: pids } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  return strikes.map((s) => ({
    id: s.id,
    player: nameOf.get(s.playerId) ?? s.playerId,
    kindLabel: STRIKE_LABEL[s.kind] ?? s.kind,
    reason: s.reason,
    week: s.week,
    issuedBy: s.issuedBy,
  }));
}
