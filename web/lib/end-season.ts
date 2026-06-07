// End-of-season rank computation. Replaces the previous tier-baseline
// math with a simple global rank: the strongest player league-wide
// gets rank 1, the weakest gets rank N. Next season's build sorts
// by rank ASC so rank 1 lands in the top tier, etc — produces the
// same tier movement as the old algorithm without the baseline magic.
//
// Sort key (best → worst):
//   1. Tier position (lower = better tier — Legendary first)
//   2. Within tier: finishing position in division (1 first)
//
// DROPPED players keep their existing rank (no penalty). Ranks are
// integers 1..N over ACTIVE players only.

import type { StandingRow } from "./standings";
import { prisma } from "./prisma";
import { computeStandings } from "./standings";
import { recordAudit, type AuditActor } from "./audit";
import { enqueueLeagueInfoRefresh } from "./queue";
import { formatSeasonLabel } from "./format-season";
import { deleteChannel, deleteGuildRole } from "./discord";

export interface DivisionForRating {
  tierPosition: number; // 1 = top tier
  // Within-tier ordering (1-based). Optional — falls back to the array
  // position in `divisions` when not supplied.
  divisionGroupNumber?: number;
  members: Array<{ playerId: string; status: "ACTIVE" | "DROPPED"; currentRating: number | null }>;
  standings: StandingRow[];
}

export interface RatingDelta {
  playerId: string;
  displayName: string;
  oldRating: number | null;
  newRating: number;
  delta: number;
  tierPosition: number;
  finishPosition: number;
  divisionSize: number;
}

export function computeRatingDeltas(
  numTiers: number,
  divisions: DivisionForRating[],
): RatingDelta[] {
  void numTiers;
  // Algorithm:
  //   1. Initial rank: sort by (tier asc, divisionGroup asc, finish asc).
  //      Rare 1 takes ranks 7-11, Rare 2 takes 12-16, etc. — the
  //      sequential-fill build flow's inverse, so a player finishing
  //      in the same position in the same division gets the same rank.
  //   2. Promo/relegate chain swap: walk every adjacent division pair
  //      in the chain (Legendary → Rare 1 → Rare 2 → ... → Common 6)
  //      and swap the bottom finisher of the upper division with the
  //      top finisher of the lower division. This is the same promo
  //      (↑ green) / relegate (↓ red) movement shown on /standings —
  //      top of each div promotes to the previous div, bottom of each
  //      div relegates to the next div. Middle players keep their rank.
  //
  // DROPPED players keep their existing rank (no penalty). Ranks are
  // integers 1..N over ACTIVE players only.
  interface FlatEntry {
    playerId: string;
    displayName: string;
    oldRating: number | null;
    tierPosition: number;
    divisionGroupNumber: number;
    finishPosition: number;
    divisionSize: number;
  }
  const entries: FlatEntry[] = [];
  divisions.forEach((div, divIdx) => {
    const droppedSet = new Set(
      div.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
    );
    const oldByPlayer = new Map(div.members.map((m) => [m.playerId, m.currentRating]));
    const active = div.standings.filter((row) => !droppedSet.has(row.player.id));
    const groupNumber = div.divisionGroupNumber ?? divIdx + 1;
    active.forEach((row, idx) => {
      entries.push({
        playerId: row.player.id,
        displayName: row.player.displayName,
        oldRating: oldByPlayer.get(row.player.id) ?? null,
        tierPosition: div.tierPosition,
        divisionGroupNumber: groupNumber,
        finishPosition: idx + 1,
        divisionSize: active.length,
      });
    });
  });
  entries.sort((a, b) => {
    if (a.tierPosition !== b.tierPosition) return a.tierPosition - b.tierPosition;
    if (a.divisionGroupNumber !== b.divisionGroupNumber) return a.divisionGroupNumber - b.divisionGroupNumber;
    return a.finishPosition - b.finishPosition;
  });

  // playerId → rank (1-based, position in `entries` after initial sort).
  const rankByPlayer = new Map<string, number>();
  entries.forEach((e, i) => rankByPlayer.set(e.playerId, i + 1));

  // Group entries by their division's (tier, group) so we can find
  // top/bottom of each. Insertion order = chain order because `entries`
  // is already sorted by (tier, group, finish).
  const divisionChain: { key: string; players: string[] }[] = [];
  const divKeyIndex = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.tierPosition}:${e.divisionGroupNumber}`;
    let idx = divKeyIndex.get(key);
    if (idx === undefined) {
      idx = divisionChain.length;
      divKeyIndex.set(key, idx);
      divisionChain.push({ key, players: [] });
    }
    divisionChain[idx]!.players.push(e.playerId);
  }

  // For each adjacent pair (A, B) in the chain, swap A's bottom with
  // B's top. Skip pairs where either side has <2 players — there's no
  // meaningful "top + bottom" distinction to swap.
  for (let i = 0; i < divisionChain.length - 1; i++) {
    const a = divisionChain[i]!.players;
    const b = divisionChain[i + 1]!.players;
    if (a.length < 2 || b.length < 2) continue;
    const bottomA = a[a.length - 1]!;
    const topB = b[0]!;
    const rA = rankByPlayer.get(bottomA)!;
    const rB = rankByPlayer.get(topB)!;
    rankByPlayer.set(bottomA, rB);
    rankByPlayer.set(topB, rA);
  }

  return entries.map((e) => {
    const newRating = rankByPlayer.get(e.playerId)!;
    return {
      playerId: e.playerId,
      displayName: e.displayName,
      oldRating: e.oldRating,
      newRating,
      delta: newRating - (e.oldRating ?? 0),
      tierPosition: e.tierPosition,
      finishPosition: e.finishPosition,
      divisionSize: e.divisionSize,
    };
  });
}

export interface DiscordTeardownResult {
  channelsDeleted: number;
  rolesDeleted: number;
  categoryDeleted: boolean;
}

// DELETE a season's Discord footprint — every division channel + division
// role and the season category — then null out the columns that pointed at
// them. Champion roles (🏆 …) are deliberately KEPT: they're keepsakes
// players hang onto across seasons, so we neither delete the role nor clear
// championRoleId. Best-effort: deleteChannel/deleteGuildRole are
// 404-tolerant and never throw, so a stale id just no-ops. Returns null
// when there's no guild configured (local/test without DISCORD_GUILD_ID).
export async function teardownSeasonDiscord(seasonId: string): Promise<DiscordTeardownResult | null> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return null;

  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      discordCategoryId: true,
      divisions: {
        select: { discordChannelId: true, discordRoleId: true },
      },
    },
  });
  if (!season) return null;

  let channelsDeleted = 0;
  let rolesDeleted = 0;

  // Channels first — a category can't be deleted while it still has children.
  for (const div of season.divisions) {
    if (div.discordChannelId && (await deleteChannel(div.discordChannelId).catch(() => false))) {
      channelsDeleted++;
    }
  }
  // Division roles only — champion roles are left untouched as keepsakes.
  for (const div of season.divisions) {
    if (div.discordRoleId && (await deleteGuildRole(guildId, div.discordRoleId).catch(() => false))) {
      rolesDeleted++;
    }
  }
  let categoryDeleted = false;
  if (season.discordCategoryId) {
    categoryDeleted = await deleteChannel(season.discordCategoryId).catch(() => false);
  }

  // Null out the now-dangling references so re-running (or re-bootstrapping)
  // starts clean. championRoleId is left as-is (the role still exists).
  await prisma.division.updateMany({
    where: { seasonId },
    data: { discordChannelId: null, discordRoleId: null },
  });
  await prisma.season.update({ where: { id: seasonId }, data: { discordCategoryId: null } });

  return { channelsDeleted, rolesDeleted, categoryDeleted };
}

export interface EndSeasonResult {
  status: "ended" | "already-ended" | "not-found";
  seasonId: string;
  seasonLabel?: string;
  divisionCount: number;
  ratingUpdateCount: number;
  discordTeardown?: DiscordTeardownResult | null;
}

// Core of ending a season — re-rank via computeRatingDeltas, write
// Player.rating + DivisionMember.finalGlobalRank, mark the season
// ended/inactive. Extracted from the endSeason server action so it can
// run from BOTH the admin UI and the /api/admin/end-season endpoint
// (and the multi-season e2e runner). No redirect/revalidate/auth here.
export async function endSeasonCore(seasonId: string, actor: AuditActor): Promise<EndSeasonResult> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: {
      tiers: { orderBy: { position: "asc" } },
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: {
          tier: true,
          members: { include: { player: true } },
          matches: { where: { status: "CONFIRMED", format: "LEAGUE_BO2" } },
        },
      },
    },
  });
  if (!season) return { status: "not-found", seasonId, divisionCount: 0, ratingUpdateCount: 0 };
  if (season.endedAt) {
    return {
      status: "already-ended",
      seasonId,
      seasonLabel: formatSeasonLabel(season),
      divisionCount: season.divisions.length,
      ratingUpdateCount: 0,
    };
  }

  const divisionsForRating: DivisionForRating[] = season.divisions.map((d) => {
    const players = d.members.map((m) => m.player);
    return {
      tierPosition: d.tier.position,
      divisionGroupNumber: d.groupNumber,
      members: d.members.map((m) => ({
        playerId: m.playerId,
        status: m.status,
        currentRating: m.player.rating,
      })),
      standings: computeStandings(players, d.matches),
    };
  });

  const deltas = computeRatingDeltas(season.tiers.length, divisionsForRating);
  const newRatingByPlayer = new Map(deltas.map((d) => [d.playerId, d.newRating]));

  // Single transaction so a partial failure doesn't leave the league half-rated.
  await prisma.$transaction([
    ...deltas.map((d) =>
      prisma.player.update({ where: { id: d.playerId }, data: { rating: d.newRating } }),
    ),
    ...Array.from(newRatingByPlayer.entries()).map(([playerId, rank]) =>
      prisma.divisionMember.updateMany({
        where: { seasonId: season.id, playerId, status: "ACTIVE" },
        data: { finalGlobalRank: rank },
      }),
    ),
    prisma.season.update({
      where: { id: season.id },
      data: { isActive: false, endedAt: new Date() },
    }),
  ]);

  // Tear down the season's Discord channels + roles. Best-effort — a
  // Discord/API failure must not undo the rating work above, so swallow it.
  let discordTeardown: DiscordTeardownResult | null = null;
  try {
    discordTeardown = await teardownSeasonDiscord(season.id);
  } catch (err) {
    console.warn("[season.end] Discord teardown failed:", err);
  }

  recordAudit({
    actor,
    action: "season.end",
    targetType: "Season",
    targetId: season.id,
    summary:
      `Ended season "${formatSeasonLabel(season)}" (${season.divisions.length} divisions, ${deltas.length} rating updates` +
      (discordTeardown
        ? `, deleted ${discordTeardown.channelsDeleted} channels + ${discordTeardown.rolesDeleted} roles`
        : "") +
      ")",
    metadata: {
      divisionCount: season.divisions.length,
      ratingUpdateCount: deltas.length,
      channelsDeleted: discordTeardown?.channelsDeleted ?? null,
      rolesDeleted: discordTeardown?.rolesDeleted ?? null,
      categoryDeleted: discordTeardown?.categoryDeleted ?? null,
    },
  });

  await enqueueLeagueInfoRefresh().catch((err) =>
    console.warn("[season.end] league-info refresh enqueue failed:", err),
  );

  return {
    status: "ended",
    seasonId: season.id,
    seasonLabel: formatSeasonLabel(season),
    divisionCount: season.divisions.length,
    ratingUpdateCount: deltas.length,
    discordTeardown,
  };
}
