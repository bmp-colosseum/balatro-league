// Awards read + pure-fold layer. An award has a preset `kind` (one of the 7 well-known kinds) or
// a custom `title`, an optional description, and one OR MORE recipient slots (AwardRecipient).
// Imported single-recipient awards store their recipient in the LEGACY Award.playerId/teamId/meta
// columns and carry no AwardRecipient rows; the fold below renders "recipients else legacy" so old
// imports display unchanged with no data migration. Writes live in lib/services/awards.ts.
import { prisma } from "@/lib/db";

// The 7 well-known preset kinds, in display order, with their labels. The single source of truth -
// season-end, the admin UI, and the write service all import from here.
export const AWARD_KINDS = [
  "MVP",
  "ROOKIE",
  "COMEBACK",
  "CAPTAIN",
  "MOST_IMPROVED",
  "BEST_SET",
  "BIGGEST_STEAL",
] as const;
export type AwardKind = (typeof AWARD_KINDS)[number];

export const AWARD_KIND_LABEL: Record<string, string> = {
  MVP: "MVP",
  ROOKIE: "Rookie of the Season",
  COMEBACK: "Comeback Player",
  CAPTAIN: "Captain of the Season",
  MOST_IMPROVED: "Most Improved",
  BEST_SET: "Best Set",
  BIGGEST_STEAL: "Biggest Steal",
};

// Pure: the display label. A custom title wins; else the preset kind label; else a generic fallback.
export function awardLabel(a: { kind: string | null; title: string | null }): string {
  const t = a.title?.trim();
  if (t) return t;
  if (a.kind) return AWARD_KIND_LABEL[a.kind] ?? a.kind;
  return "Award";
}

export interface AwardRecipientView {
  id: string | null; // AwardRecipient.id, or null for a recipient synthesized from legacy fields
  playerId: string | null;
  player: string | null;
  teamId: string | null;
  team: string | null;
  note: string | null;
}
export interface AwardView {
  id: string;
  kind: string | null;
  label: string;
  description: string | null;
  sortIndex: number;
  recipients: AwardRecipientView[];
}

interface AwardRow {
  id: string;
  kind: string | null;
  title: string | null;
  description: string | null;
  sortIndex: number;
  playerId: string | null;
  teamId: string | null;
  meta: unknown;
  recipients: { id: string; playerId: string | null; teamId: string | null; note: string | null; sortIndex: number }[];
}

// Pure fold: recipient slots win; else synthesize ONE recipient from the legacy player/team/meta.team
// (imported single-recipient awards). No I/O - names come from the supplied maps.
export function foldAward(a: AwardRow, playerName: Map<string, string>, teamName: Map<string, string>): AwardView {
  const legacyTeamName = (a.meta as { team?: string } | null)?.team ?? null;
  let recipients: AwardRecipientView[];
  if (a.recipients.length) {
    recipients = [...a.recipients]
      .sort((x, y) => x.sortIndex - y.sortIndex)
      .map((r) => ({
        id: r.id,
        playerId: r.playerId,
        player: r.playerId ? playerName.get(r.playerId) ?? r.playerId : null,
        teamId: r.teamId,
        team: r.teamId ? teamName.get(r.teamId) ?? null : null,
        note: r.note,
      }));
  } else if (a.playerId || a.teamId || legacyTeamName) {
    recipients = [
      {
        id: null,
        playerId: a.playerId,
        player: a.playerId ? playerName.get(a.playerId) ?? a.playerId : null,
        teamId: a.teamId,
        team: legacyTeamName ?? (a.teamId ? teamName.get(a.teamId) ?? null : null),
        note: null,
      },
    ];
  } else {
    recipients = [];
  }
  return { id: a.id, kind: a.kind, label: awardLabel(a), description: a.description, sortIndex: a.sortIndex, recipients };
}

// Load + fold every award for a season (shell for the season page + admin end page).
export async function loadSeasonAwards(seasonId: string): Promise<AwardView[]> {
  const awards = await prisma.award.findMany({
    where: { seasonId },
    orderBy: { sortIndex: "asc" },
    select: {
      id: true, kind: true, title: true, description: true, sortIndex: true, playerId: true, teamId: true, meta: true,
      recipients: { select: { id: true, playerId: true, teamId: true, note: true, sortIndex: true } },
    },
  });
  const pids = new Set<string>();
  const tids = new Set<string>();
  for (const a of awards) {
    if (a.playerId) pids.add(a.playerId);
    if (a.teamId) tids.add(a.teamId);
    for (const r of a.recipients) {
      if (r.playerId) pids.add(r.playerId);
      if (r.teamId) tids.add(r.teamId);
    }
  }
  const [players, teams] = await Promise.all([
    pids.size ? prisma.player.findMany({ where: { id: { in: [...pids] } }, select: { id: true, displayName: true } }) : Promise.resolve([]),
    tids.size ? prisma.team.findMany({ where: { id: { in: [...tids] } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const playerName = new Map(players.map((p) => [p.id, p.displayName]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  return awards
    .map((a) => foldAward(a, playerName, teamName))
    .sort((a, b) => a.sortIndex - b.sortIndex || a.label.localeCompare(b.label));
}

export async function getSeasonAwards(seasonName: string): Promise<AwardView[]> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) return [];
  return loadSeasonAwards(season.id);
}

// Every award a player has WON - as a recipient slot (new) or the legacy single-recipient field.
export async function getPlayerAwards(playerId: string): Promise<{ kind: string | null; label: string; season: string; note: string | null }[]> {
  const awards = await prisma.award.findMany({
    where: { OR: [{ playerId }, { recipients: { some: { playerId } } }] },
    select: {
      kind: true, title: true, seasonId: true,
      recipients: { where: { playerId }, select: { note: true } },
    },
  });
  const seasons = await prisma.tourSeason.findMany({ where: { id: { in: awards.map((a) => a.seasonId) } }, select: { id: true, name: true } });
  const nameOf = new Map(seasons.map((s) => [s.id, s.name]));
  const num = (s: string) => Number(s.match(/(\d+)/)?.[1] ?? 0);
  return awards
    .map((a) => ({ kind: a.kind, label: awardLabel(a), season: nameOf.get(a.seasonId) ?? a.seasonId, note: a.recipients[0]?.note ?? null }))
    .sort((x, y) => num(x.season) - num(y.season));
}
