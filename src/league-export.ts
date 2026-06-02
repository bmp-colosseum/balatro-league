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
  visibility: string;
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
    pairings: Array<{
      id: string;
      playerAId: string;
      playerBId: string;
      gamesWonA: number;
      gamesWonB: number;
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
            pairings: {
              select: {
                id: true,
                playerAId: true,
                playerBId: true,
                gamesWonA: true,
                gamesWonB: true,
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
      visibility: s.visibility,
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
        pairings: d.pairings.map((p) => ({
          id: p.id,
          playerAId: p.playerAId,
          playerBId: p.playerBId,
          gamesWonA: p.gamesWonA,
          gamesWonB: p.gamesWonB,
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
