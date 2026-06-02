// Loader for the /me page. Single-purpose: returns only what the page
// renders. Three lookups:
//   1. Player row (auto-syncs displayName from Discord if not custom)
//   2. Active membership + opponents not yet played + cached standings
//   3. SeasonInterest row for the notify-me-next-season state
//
// Side effect: the displayName auto-sync IS an update under the right
// conditions (player.hasCustomDisplayName === false AND Discord name
// changed). Kept inside the loader so the side effect lives next to
// the read that depends on it, not buried in the page's render flow.

import { prisma } from "@/lib/prisma";
import { getLeagueSettingsForSeason, type ScoringConfig } from "@/lib/league-settings";
import { formatSeasonLabel } from "@/lib/format-season";

export interface MeStandingsRow {
  points: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface MeDivisionContext {
  divisionId: string;
  divisionName: string;
  seasonId: string;
  seasonName: string;
  tierName: string;
  tierPosition: number;
  reportableOpponents: Array<{ playerId: string; displayName: string }>;
  myStandings: MeStandingsRow | null;
}

export interface MePageData {
  player:
    | {
        id: string;
        discordId: string;
        displayName: string;
        hasCustomDisplayName: boolean;
      }
    | null;
  division: MeDivisionContext | null;
  interest: { subscribedAt: Date } | null;
}

export async function loadMePageData(
  discordId: string,
  discordName: string | null | undefined,
): Promise<MePageData> {
  const playerFresh = await prisma.player.findUnique({
    where: { discordId },
    select: { id: true, discordId: true, displayName: true, hasCustomDisplayName: true },
  });
  // Auto-sync display name from Discord when the player hasn't set a
  // custom override. Bounded write — only fires when names differ.
  let player = playerFresh;
  if (
    player &&
    discordName &&
    !player.hasCustomDisplayName &&
    player.displayName !== discordName
  ) {
    player = await prisma.player.update({
      where: { discordId },
      data: { displayName: discordName },
      select: { id: true, discordId: true, displayName: true, hasCustomDisplayName: true },
    });
  }

  const [interest, division] = await Promise.all([
    prisma.seasonInterest.findUnique({
      where: { discordId },
      select: { subscribedAt: true },
    }),
    player ? loadActiveDivisionContext(player.id) : Promise.resolve(null),
  ]);

  return { player, division, interest };
}

async function loadActiveDivisionContext(
  playerId: string,
): Promise<MeDivisionContext | null> {
  const membership = await prisma.divisionMember.findFirst({
    where: {
      playerId,
      status: "ACTIVE",
      division: { season: { isActive: true, visibility: "PUBLIC" } },
    },
    select: {
      division: {
        select: {
          id: true,
          name: true,
          seasonId: true,
          tier: { select: { name: true, position: true } },
          season: { select: { number: true, subtitle: true } },
          // All ACTIVE members so we can list opponents. Player rows are
          // tiny — id + displayName.
          members: {
            where: { status: "ACTIVE" },
            select: { playerId: true, player: { select: { id: true, displayName: true } } },
          },
        },
      },
    },
  });
  if (!membership) return null;
  const div = membership.division;

  // Only the player's OWN CONFIRMED pairings (to know who they've
  // already played) — not the whole division's pairing table.
  const myPairings = await prisma.pairing.findMany({
    where: {
      divisionId: div.id,
      status: "CONFIRMED",
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: { playerAId: true, playerBId: true },
  });
  const playedOpponentIds = new Set<string>();
  for (const p of myPairings) {
    if (p.playerAId === playerId) playedOpponentIds.add(p.playerBId);
    else if (p.playerBId === playerId) playedOpponentIds.add(p.playerAId);
  }
  const reportableOpponents = div.members
    .filter((m) => m.playerId !== playerId && !playedOpponentIds.has(m.playerId))
    .map((m) => ({ playerId: m.playerId, displayName: m.player.displayName }));

  // Cached standings row for this player. Falls back to deriving from
  // confirmed pairings if cache is cold (rare — recompute fires on
  // every confirm).
  const cached = await prisma.divisionStandings.findUnique({
    where: { divisionId: div.id },
    select: { rowsJson: true },
  });
  let myStandings: MeStandingsRow | null = null;
  if (cached) {
    try {
      const rows = JSON.parse(cached.rowsJson) as Array<
        { playerId: string } & MeStandingsRow
      >;
      const row = rows.find((r) => r.playerId === playerId);
      if (row) {
        myStandings = {
          points: row.points,
          wins: row.wins,
          draws: row.draws,
          losses: row.losses,
        };
      }
    } catch {
      // bad JSON — fall through to null
    }
  }
  if (!myStandings) {
    // Cold-cache fallback: tally the player's own pairings. Uses
    // current LeagueSettings scoring (matches what the cache would
    // produce when it's next computed).
    myStandings = await deriveStandingsFromPairings(playerId, div.id);
  }

  return {
    divisionId: div.id,
    divisionName: div.name,
    seasonId: div.seasonId,
    seasonName: formatSeasonLabel(div.season),
    tierName: div.tier.name,
    tierPosition: div.tier.position,
    reportableOpponents,
    myStandings,
  };
}

async function deriveStandingsFromPairings(
  playerId: string,
  divisionId: string,
): Promise<MeStandingsRow | null> {
  const allMine = await prisma.pairing.findMany({
    where: {
      divisionId,
      status: "CONFIRMED",
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: { playerAId: true, gamesWonA: true, gamesWonB: true },
  });
  if (allMine.length === 0) {
    return { points: 0, wins: 0, draws: 0, losses: 0 };
  }
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    select: { seasonId: true },
  });
  if (!division) return null;
  const { scoring } = await getLeagueSettingsForSeason(division.seasonId);
  return tallyForPlayer(playerId, allMine, scoring);
}

function tallyForPlayer(
  playerId: string,
  pairings: Array<{ playerAId: string; gamesWonA: number; gamesWonB: number }>,
  scoring: ScoringConfig,
): MeStandingsRow {
  let points = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const p of pairings) {
    const meIsA = p.playerAId === playerId;
    const mine = meIsA ? p.gamesWonA : p.gamesWonB;
    const opp = meIsA ? p.gamesWonB : p.gamesWonA;
    if (mine === 2 && opp === 0) {
      points += scoring.pointsFor20Win;
      wins++;
    } else if (mine === 0 && opp === 2) {
      points += scoring.pointsForLoss;
      losses++;
    } else if (mine === 1 && opp === 1) {
      points += scoring.pointsFor11Draw;
      draws++;
    }
  }
  return { points, wins, draws, losses };
}
