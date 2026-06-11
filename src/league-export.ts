// JSON snapshot of the league's restorable state. Used by both the
// weekly auto-backup (pg-boss schedule) and the /admin export-results
// command for on-demand dumps. Off-platform redundancy in case Railway
// loses the DB — admin can reconstruct seasons + standings from the
// most recent attachment in bot-commands.
//
// Includes EVERY season (active + ended + draft) so we capture the
// full history, not just whatever's currently visible. PlayerMmrSnapshot
// excluded — they're external-source data, regeneratable on demand.

import { prisma } from "./db.js";

interface ExportPlayer {
  id: string;
  discordId: string;
  displayName: string;
  rating: number | null;
  ratingNote: string | null;
}

interface ExportSeason {
  id: string;
  number: number;
  subtitle: string | null;
  startedAt: string;
  endedAt: string | null;
  archivedAt: string | null;
  isActive: boolean;
  targetGroupSize: number;
  minGroupSize: number;
  matchConfigPresetId: string | null;
  discordCategoryId: string | null;
  resultsWebhookUrl: string | null;
  resultsChannelId: string | null;
  tiers: Array<{ id: string; position: number; name: string }>;
  divisions: Array<{
    id: string;
    tierId: string;
    name: string;
    groupNumber: number;
    targetSize: number | null;
    discordRoleId: string | null;
    discordChannelId: string | null;
    members: Array<{
      playerId: string;
      status: string;
      joinedAt: string;
      droppedAt: string | null;
      dropoutReason: string | null;
    }>;
    matches: Array<{
      id: string;
      format: string;
      playerAId: string;
      playerBId: string;
      gamesWonA: number;
      gamesWonB: number;
      winnerId: string | null;
      status: string;
      reportedAt: string | null;
      confirmedAt: string | null;
      adminOverrideBy: string | null;
      adminOverrideReason: string | null;
    }>;
  }>;
}

export interface LeagueExport {
  exportedAt: string;
  schemaVersion: 1;
  players: ExportPlayer[];
  seasons: ExportSeason[];
}

export async function buildLeagueExport(): Promise<LeagueExport> {
  const [players, seasons] = await Promise.all([
    prisma.player.findMany({
      select: {
        id: true,
        discordId: true,
        displayName: true,
        rating: true,
        ratingNote: true,
      },
      orderBy: { displayName: "asc" },
    }),
    prisma.season.findMany({
      include: {
        tiers: { orderBy: { position: "asc" }, select: { id: true, position: true, name: true } },
        divisions: {
          orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
          include: {
            members: {
              select: {
                playerId: true,
                status: true,
                joinedAt: true,
                droppedAt: true,
                dropoutReason: true,
              },
            },
            matches: {
              select: {
                id: true,
                format: true,
                playerAId: true,
                playerBId: true,
                gamesWonA: true,
                gamesWonB: true,
                winnerId: true,
                status: true,
                reportedAt: true,
                confirmedAt: true,
                adminOverrideBy: true,
                adminOverrideReason: true,
              },
            },
          },
        },
      },
      orderBy: { startedAt: "asc" },
    }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    players,
    seasons: seasons.map((s) => ({
      id: s.id,
      number: s.number,
      subtitle: s.subtitle,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
      isActive: s.isActive,
      targetGroupSize: s.targetGroupSize,
      minGroupSize: s.minGroupSize,
      matchConfigPresetId: s.matchConfigPresetId,
      discordCategoryId: s.discordCategoryId,
      resultsWebhookUrl: s.resultsWebhookUrl,
      resultsChannelId: s.resultsChannelId,
      tiers: s.tiers,
      divisions: s.divisions.map((d) => ({
        id: d.id,
        tierId: d.tierId,
        name: d.name,
        groupNumber: d.groupNumber,
        targetSize: d.targetSize,
        discordRoleId: d.discordRoleId,
        discordChannelId: d.discordChannelId,
        members: d.members.map((m) => ({
          playerId: m.playerId,
          status: m.status,
          joinedAt: m.joinedAt.toISOString(),
          droppedAt: m.droppedAt ? m.droppedAt.toISOString() : null,
          dropoutReason: m.dropoutReason,
        })),
        matches: d.matches.map((p) => ({
          id: p.id,
          format: p.format,
          playerAId: p.playerAId,
          playerBId: p.playerBId,
          gamesWonA: p.gamesWonA,
          gamesWonB: p.gamesWonB,
          winnerId: p.winnerId,
          status: p.status,
          reportedAt: p.reportedAt ? p.reportedAt.toISOString() : null,
          confirmedAt: p.confirmedAt ? p.confirmedAt.toISOString() : null,
          adminOverrideBy: p.adminOverrideBy,
          adminOverrideReason: p.adminOverrideReason,
        })),
      })),
    })),
  };
}

export function serializeExport(data: LeagueExport): Buffer {
  // Pretty-printed for greppability — file size is tiny (~100KB at
  // current scale), the readability gain dominates.
  return Buffer.from(JSON.stringify(data, null, 2), "utf-8");
}

export function exportFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `balatro-league-backup-${ts}.json`;
}

// FULL dump — every row of every model, for an exact rebuild after a schema
// change. Shared by the export:full script and the daily Discord backup.
const FULL_MODELS = [
  "player", "playerMmrSnapshot", "season", "signupRound", "signup",
  "matchConfigPreset", "matchSession", "leagueConfig", "seasonInterest", "roleBinding",
  "tierTemplate", "tier", "division", "divisionStandings", "divisionMember",
  "match", "game", "gameDeck", "leagueRulesTemplate", "adminAuditEvent",
] as const;

export async function buildFullExport(): Promise<{ data: Record<string, unknown>; rowCount: number }> {
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), schemaVersion: 1 };
  const client = prisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>;
  let rowCount = 0;
  for (const model of FULL_MODELS) {
    const rows = await client[model]!.findMany();
    out[model] = rows;
    rowCount += rows.length;
  }
  return { data: out, rowCount };
}

export function fullExportFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `balatro-league-full-${ts}.json`;
}
