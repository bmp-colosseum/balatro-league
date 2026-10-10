import "server-only";

// Who is new to the league THIS season -- their first-ever division
// membership is in the currently active season. Feeds the "New players" step
// card on /admin/season-tools: how many, who, and whether they've already
// gotten the onboarding-guide DM. Gather-then-decide: every DB read happens
// here, findNewcomerPlayerIds (the only decision) is pure and unit-tested on
// its own.

import { prisma } from "@/lib/prisma";
import { findNewcomerPlayerIds, type SeasonMembership } from "@/lib/newcomers-core";

export const ONBOARDING_GUIDE_KIND = "onboarding-guide";

export interface NewcomerPlayer {
  playerId: string;
  discordId: string;
  displayName: string;
  username: string | null;
  alreadySentGuide: boolean;
}

export interface NewcomersData {
  seasonId: string | null;
  seasonNumber: number | null;
  newcomers: NewcomerPlayer[];
}

export async function loadNewcomers(): Promise<NewcomersData> {
  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, number: true },
  });
  if (!activeSeason) return { seasonId: null, seasonNumber: null, newcomers: [] };

  // DivisionMember.seasonId is denormalized straight off Division.seasonId
  // (see schema comment), so this needs no join through division -- every
  // player's full season history in two flat queries.
  const [memberRows, seasons] = await Promise.all([
    prisma.divisionMember.findMany({ select: { playerId: true, seasonId: true } }),
    prisma.season.findMany({ select: { id: true, number: true } }),
  ]);
  const seasonNumberById = new Map(seasons.map((s) => [s.id, s.number]));
  const memberships: SeasonMembership[] = [];
  for (const row of memberRows) {
    const seasonNumber = seasonNumberById.get(row.seasonId);
    if (seasonNumber !== undefined) memberships.push({ playerId: row.playerId, seasonNumber });
  }

  const newcomerIds = findNewcomerPlayerIds(memberships, activeSeason.number);
  if (newcomerIds.length === 0) {
    return { seasonId: activeSeason.id, seasonNumber: activeSeason.number, newcomers: [] };
  }

  const players = await prisma.player.findMany({
    where: { id: { in: newcomerIds } },
    select: { id: true, discordId: true, displayName: true, username: true },
  });
  const sentDeliveries = await prisma.dmDelivery.findMany({
    where: {
      kind: ONBOARDING_GUIDE_KIND,
      status: "sent",
      discordId: { in: players.map((p) => p.discordId) },
    },
    select: { discordId: true },
  });
  const sentDiscordIds = new Set(sentDeliveries.map((d) => d.discordId));

  const newcomers = players
    .map((p) => ({
      playerId: p.id,
      discordId: p.discordId,
      displayName: p.displayName,
      username: p.username,
      alreadySentGuide: sentDiscordIds.has(p.discordId),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { seasonId: activeSeason.id, seasonNumber: activeSeason.number, newcomers };
}
